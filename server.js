const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bcrypt = require("bcrypt");

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// ✅ FIX: เปลี่ยนตัวแปร db ให้รองรับ Connection Pool
let db;

// ------------------- Database Credentials -------------------
const dbConfig = {
  host: "202.28.34.203",
  user: "mb68_66011212155",
  password: "uKayQT6Ly2i(",
  database: "mb68_66011212155",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // ✅ FIX: แก้ปัญหา toDouble ที่ต้นเหตุ ทำให้ mysql2 แปลง DECIMAL เป็น Number อัตโนมัติ
  decimalNumbers: true,
};

// ------------------- Connect to DB & Create Tables -------------------
async function connectAndSetupDb() {
  try {
    // ✅ FIX: สร้าง Connection Pool เพียงครั้งเดียวตอนเริ่ม Server
    db = mysql.createPool(dbConfig);
    console.log("Connected to MySQL database via connection pool.");

    // Create tables
    await db.execute(`
      CREATE TABLE IF NOT EXISTS customer (
        cus_id INT PRIMARY KEY AUTO_INCREMENT,
        fullname VARCHAR(255),
        phone VARCHAR(255),
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        wallet_balance DECIMAL(10, 2) DEFAULT 0,
        role VARCHAR(255) DEFAULT 'user'
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS lotto (
        lotto_id INT PRIMARY KEY AUTO_INCREMENT,
        number VARCHAR(255),
        round INT,
        price DECIMAL(10, 2) DEFAULT 80,
        status VARCHAR(255) DEFAULT 'available'
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS purchase (
        purchase_id INT PRIMARY KEY AUTO_INCREMENT,
        cus_id INT,
        lotto_id INT,
        round INT,
        purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_redeemed TINYINT DEFAULT 0,
        FOREIGN KEY (cus_id) REFERENCES customer(cus_id),
        FOREIGN KEY (lotto_id) REFERENCES lotto(lotto_id)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS prize (
        prize_id INT PRIMARY KEY AUTO_INCREMENT,
        round INT,
        prize_type VARCHAR(255),
        number VARCHAR(255),
        reward_amount DECIMAL(10, 2)
      )
    `);

    await seedAdmin();
  } catch (err) {
    console.error("FATAL ERROR: Failed to connect or set up DB:", err.message);
    process.exit(1);
  }
}

// ------------------- Utils -------------------
async function hashPassword(password) {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
}

// ------------------- Seed Admin -------------------
async function seedAdmin() {
  try {
    const adminEmail = "admin@example.com";
    const adminPassword = "admin123";

    const [rows] = await db.execute("SELECT * FROM customer WHERE email = ?", [adminEmail]);
    if (rows.length === 0) {
      const hashedPassword = await hashPassword(adminPassword);
      await db.execute(
        "INSERT INTO customer (fullname, phone, email, password, wallet_balance, role) VALUES (?, ?, ?, ?, ?, ?)",
        ["Administrator", "0000000000", adminEmail, hashedPassword, 1000, "admin"]
      );
      console.log(`Admin account created: ${adminEmail} / ${adminPassword}`);
    } else {
      console.log("Admin account already exists");
    }
  } catch(err) {
      console.error("Failed to seed admin:", err.message);
  }
}

// ------------------- Helper: Generate Lotto -------------------
// ------------------- Helper: Generate Lotto -------------------
async function generateLotto(round, amount = 100) {
  let connection;
  try {
    connection = await db.getConnection();
    await connection.execute("DELETE FROM lotto WHERE round = ?", [round]);

    const generated = new Set();
    while (generated.size < amount) {
      const num = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
      if (!generated.has(num)) {
        generated.add(num);
        // ✅ ใช้ execute ธรรมดาแทน prepare
        await connection.execute(
          "INSERT INTO lotto (number, round, price, status) VALUES (?, ?, ?, ?)",
          [num, round, 80, "available"]
        );
      }
    }

    return Array.from(generated);
  } catch (error) {
    console.error("Error in generateLotto:", error);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}


// ------------------- Helper: Draw Prizes -------------------
// ------------------- Helper: Draw Prizes -------------------
// ------------------- Helper: Draw Prizes -------------------
async function drawPrizes(round) {
    let connection;
    try {
        // 1. ดึง Connection จาก Pool
        connection = await db.getConnection();
        await connection.beginTransaction(); // **เริ่ม Transaction**

        // 2. ตรวจสอบว่าสุ่มไปแล้วหรือยัง (Lock ตาราง prize สำหรับงวดนี้)
        const [prizeCountResult] = await connection.execute(
            "SELECT COUNT(*) AS cnt FROM prize WHERE round = ? FOR UPDATE", // **LOCK FOR UPDATE**
            [round]
        );
        if (prizeCountResult[0].cnt > 0) {
            await connection.rollback();
            throw new Error("รางวัลงวดนี้ถูกสุ่มไปแล้ว");
        }

        // 3. ดึงเลขทั้งหมดที่ available
        const [lottoNumbersResult] = await connection.execute(
            "SELECT number FROM lotto WHERE round = ? AND status = 'available'", // ใช้เลขที่ยังไม่ถูกขายก็ได้
            [round]
        );
        if (lottoNumbersResult.length < 4) {
            await connection.rollback();
            throw new Error("มีเลขในระบบไม่เพียงพอที่จะสุ่มรางวัล");
        }

        const shuffled = lottoNumbersResult.map((r) => r.number).sort(() => 0.5 - Math.random());

        const prizes = [
            { prize_type: "รางวัลที่ 1", number: shuffled[0], reward_amount: 6000000 },
            { prize_type: "รางวัลที่ 2", number: shuffled[1], reward_amount: 200000 },
            { prize_type: "รางวัลที่ 3", number: shuffled[2], reward_amount: 80000 },
            { prize_type: "เลขท้าย 3 ตัว", number: shuffled[0].slice(-3), reward_amount: 4000 },
            { prize_type: "เลขท้าย 2 ตัว", number: shuffled[3].slice(-2), reward_amount: 2000 },
        ];
        
        // 4. เตรียมคำสั่ง INSERT และดำเนินการใน Connection เดียวกัน
        // ไม่จำเป็นต้องใช้ prepare/close ถ้าใช้ execute ธรรมดา
        const insertPromises = prizes.map(p =>
            connection.execute(
                "INSERT INTO prize (round, prize_type, number, reward_amount) VALUES (?, ?, ?, ?)",
                [round, p.prize_type, p.number, p.reward_amount]
            )
        );
        await Promise.all(insertPromises);

        await connection.commit(); // **Commit Transaction**
        return prizes;
    } catch(error) {
        if (connection) await connection.rollback(); // Rollback ถ้ามี error
        console.error("Error in drawPrizes:", error);
        throw error;
    } finally {
        if (connection) connection.release(); // คืน Connection
    }
}

// ------------------- API -------------------

// Register
app.post("/register", async (req, res) => {
  const { fullname, phone, email, password } = req.body;
  if (!fullname || !phone || !email || !password) {
    return res.status(400).json({ message: "กรุณากรอกข้อมูลให้ครบถ้วน" });
  }

  try {
    const hashedPassword = await hashPassword(password);
    const [result] = await db.execute(
      `INSERT INTO customer (fullname, phone, email, password, wallet_balance, role) VALUES (?, ?, ?, ?, ?, ?)`,
      [fullname, phone, email, hashedPassword, 0, 'user'] // wallet_balance เริ่มที่ 0, role เป็น user เสมอ
    );

    res.status(201).json({
      message: "สมัครสมาชิกสำเร็จ",
      cus_id: result.insertId,
      fullname,
      phone,
      email,
      wallet_balance: 0,
      role: 'user',
    });
  } catch (err) {
    console.error("Register Error:", err);
    if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: "มีอีเมลนี้ในระบบแล้ว" });
    }
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการสมัครสมาชิก" });
  }
});

// Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: "กรุณากรอก email และ password" });
  }

  try {
    const [rows] = await db.execute("SELECT * FROM customer WHERE email = ?", [email]);
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ message: "ไม่พบบัญชีผู้ใช้นี้" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "รหัสผ่านไม่ถูกต้อง" });
    }

    // ✅ FIX: ไม่ต้องแปลงค่าใดๆ เพราะ decimalNumbers:true จัดการให้แล้ว
    // ลบ field password ออกจาก object ที่จะส่งกลับไปเพื่อความปลอดภัย
    delete user.password; 
    res.json({
      message: "เข้าสู่ระบบสำเร็จ",
      customer: user,
    });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ" });
  }
});

// Buy Lotto
app.post("/buy", async (req, res) => {
  const { cus_id, lotto_id, round } = req.body;
  if (!cus_id || !lotto_id || !round) {
    return res.status(400).json({ message: "ข้อมูลไม่ครบถ้วน" });
  }

  // ✅ FIX: ใช้ Transaction จาก Connection Pool
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [lottoRows] = await connection.execute("SELECT * FROM lotto WHERE lotto_id = ? AND round = ? FOR UPDATE", [lotto_id, round]);
    const lotto = lottoRows[0];

    if (!lotto) {
      await connection.rollback();
      return res.status(404).json({ message: "ไม่พบสลากใบนี้" });
    }
    if (lotto.status !== "available") {
      await connection.rollback();
      return res.status(400).json({ message: "สลากใบนี้ถูกซื้อไปแล้ว" });
    }

    const [customerRows] = await connection.execute("SELECT wallet_balance FROM customer WHERE cus_id = ? FOR UPDATE", [cus_id]);
    const customer = customerRows[0];

    if (!customer) {
      await connection.rollback();
      return res.status(404).json({ message: "ไม่พบข้อมูลผู้ใช้" });
    }

    if (customer.wallet_balance < lotto.price) {
      await connection.rollback();
      return res.status(400).json({ message: "ยอดเงินไม่เพียงพอ" });
    }

    await connection.execute("UPDATE customer SET wallet_balance = wallet_balance - ? WHERE cus_id = ?", [lotto.price, cus_id]);
    await connection.execute("UPDATE lotto SET status = 'sold' WHERE lotto_id = ?", [lotto_id]);
    const [purchaseResult] = await connection.execute(`INSERT INTO purchase (cus_id, lotto_id, round) VALUES (?, ?, ?)`, [cus_id, lotto_id, round]);

    await connection.commit();

    const [finalBalanceRows] = await db.execute("SELECT wallet_balance FROM customer WHERE cus_id = ?", [cus_id]);

    res.json({
      message: "ซื้อสำเร็จ",
      purchase_id: purchaseResult.insertId,
      lotto: {
        lotto_id,
        number: lotto.number,
        round,
      },
      wallet_balance: finalBalanceRows[0].wallet_balance,
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Buy Error:", err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการทำรายการ" });
  } finally {
    if (connection) connection.release();
  }
});
// Show all lotto
app.get("/show-all-lotto", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT lotto_id, number, round, price, status FROM lotto ORDER BY round DESC, number ASC"
    );
    res.json({ lotto: rows });
  } catch (err) {
    console.error("Show all lotto error:", err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการดึงข้อมูล Lotto ทั้งหมด" });
  }
});

app.post("/reset-lotto", async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.execute("DELETE FROM purchase");
    await connection.execute("DELETE FROM prize");
    await connection.execute("DELETE FROM lotto");

    await connection.execute("ALTER TABLE purchase AUTO_INCREMENT = 1");
    await connection.execute("ALTER TABLE prize AUTO_INCREMENT = 1");
    await connection.execute("ALTER TABLE lotto AUTO_INCREMENT = 1");

    await connection.commit();
    res.json({ message: "รีเซ็ตข้อมูล Lotto เรียบร้อยแล้ว" });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Reset Lotto Error:", err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการรีเซ็ต Lotto", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Redeem Prize
app.post("/redeem/:purchase_id", async (req, res) => {
  const { purchase_id } = req.params;

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [purchaseRows] = await connection.execute("SELECT * FROM purchase WHERE purchase_id = ? FOR UPDATE", [purchase_id]);
    const purchase = purchaseRows[0];

    if (!purchase) {
      await connection.rollback();
      return res.status(404).json({ message: "ไม่พบข้อมูลการซื้อ" });
    }
    if (purchase.is_redeemed) {
      await connection.rollback();
      return res.status(400).json({ message: "สลากใบนี้ถูกขึ้นรางวัลไปแล้ว" });
    }

    const [lottoRows] = await connection.execute("SELECT number, round FROM lotto WHERE lotto_id = ?", [purchase.lotto_id]);
    const lotto = lottoRows[0];

    const [prizeRows] = await connection.execute("SELECT * FROM prize WHERE round = ?", [lotto.round]);
    if (prizeRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ message: "ยังไม่มีการออกรางวัลในงวดนี้" });
    }

    const matchedPrizes = prizeRows.filter(p => 
        (p.prize_type.startsWith("รางวัลที่") && p.number === lotto.number) ||
        (p.prize_type === "เลขท้าย 3 ตัว" && lotto.number.endsWith(p.number)) ||
        (p.prize_type === "เลขท้าย 2 ตัว" && lotto.number.endsWith(p.number))
    );

    if (matchedPrizes.length === 0) {
      await connection.rollback();
      return res.status(400).json({ message: "เสียใจด้วย! สลากใบนี้ไม่ถูกรางวัล" });
    }

    const totalReward = matchedPrizes.reduce((sum, p) => sum + p.reward_amount, 0);

    await connection.execute("UPDATE customer SET wallet_balance = wallet_balance + ? WHERE cus_id = ?", [totalReward, purchase.cus_id]);
    await connection.execute("UPDATE purchase SET is_redeemed = 1 WHERE purchase_id = ?", [purchase_id]);
    await connection.commit();

    res.json({
      message: `ยินดีด้วย! คุณถูกรางวัล รวมเป็นเงิน ${totalReward} บาท`,
      totalReward,
      prizes: matchedPrizes,
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Redeem Error:", err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการขึ้นเงินรางวัล" });
  } finally {
    if (connection) connection.release();
  }
});
// Draw prizes from sold lotto

app.post("/draw-from-sold/:round", async (req, res) => {
    const { round } = req.params;

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction(); // **เริ่ม Transaction**

        // 1. ตรวจสอบว่าสุ่มไปแล้วหรือยัง (Lock ตาราง prize)
        const [existingPrizes] = await connection.execute(
            "SELECT COUNT(*) AS cnt FROM prize WHERE round = ? FOR UPDATE", // **LOCK FOR UPDATE**
            [round]
        );
        if (existingPrizes[0].cnt > 0) {
            await connection.rollback();
            return res.status(400).json({ message: "รางวัลงวดนี้ถูกสุ่มไปแล้ว" });
        }

        // 2. ดึงเลขที่ขายแล้ว
        const [soldLottos] = await connection.execute(
            "SELECT number FROM lotto WHERE round = ? AND status = 'sold'",
            [round]
        );
        if (soldLottos.length < 4) {
            await connection.rollback();
            return res.status(400).json({ message: "มีเลขที่ขายไม่เพียงพอสำหรับการสุ่มรางวัล" });
        }

        const shuffled = soldLottos.map(r => r.number).sort(() => 0.5 - Math.random());

        const prizes = [
            { prize_type: "รางวัลที่ 1", number: shuffled[0], reward_amount: 6000000 },
            { prize_type: "รางวัลที่ 2", number: shuffled[1], reward_amount: 200000 },
            { prize_type: "รางวัลที่ 3", number: shuffled[2], reward_amount: 80000 },
            { prize_type: "เลขท้าย 3 ตัว", number: shuffled[0].slice(-3), reward_amount: 4000 },
            { prize_type: "เลขท้าย 2 ตัว", number: shuffled[3].slice(-2), reward_amount: 2000 },
        ];

        // 3. Insert ข้อมูลรางวัล (ใช้ execute ธรรมดาใน Transaction)
        const insertPromises = prizes.map(p =>
            connection.execute(
                "INSERT INTO prize (round, prize_type, number, reward_amount) VALUES (?, ?, ?, ?)",
                [round, p.prize_type, p.number, p.reward_amount]
            )
        );
        await Promise.all(insertPromises);

        await connection.commit(); // **Commit Transaction**

        res.json({ message: `สุ่มรางวัลจากล็อตโต้ที่ขายแล้วงวด ${round} สำเร็จ`, prizes });
    } catch (err) {
        if (connection) await connection.rollback(); // Rollback ถ้ามี error
        console.error("Draw from sold error:", err);
        res.status(500).json({ message: "เกิดข้อผิดพลาดในการสุ่มรางวัลจากล็อตโต้ที่ขายแล้ว" });
    } finally {
        if (connection) connection.release(); // คืน Connection
    }
});



// Reset System
app.post("/reset-system", async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        await connection.execute("DELETE FROM purchase");
        await connection.execute("DELETE FROM prize");
        await connection.execute("DELETE FROM lotto");
        await connection.execute("DELETE FROM customer WHERE role != 'admin'");
        
        await connection.execute("ALTER TABLE purchase AUTO_INCREMENT = 1");
        await connection.execute("ALTER TABLE prize AUTO_INCREMENT = 1");
        await connection.execute("ALTER TABLE lotto AUTO_INCREMENT = 1");
        
        const [maxAdminId] = await connection.execute("SELECT MAX(cus_id) as maxId FROM customer WHERE role = 'admin'");
        const nextId = (maxAdminId[0].maxId || 0) + 1;
        await connection.execute(`ALTER TABLE customer AUTO_INCREMENT = ${nextId}`);

        await connection.commit();
        res.json({ message: "รีเซ็ตระบบเรียบร้อยแล้ว (ยกเว้นข้อมูลแอดมิน)" });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error("Reset System Error:", err);
        res.status(500).json({ message: "เกิดข้อผิดพลาดในการรีเซ็ตระบบ" });
    } finally {
        if (connection) connection.release();
    }
});


// ------------------- โค้ดส่วนที่เหลือ (เหมือนเดิมแต่ปรับปรุง error handling) -------------------

// Current round (next)
// Current round = ล่าสุดที่ออกรางวัลแล้ว
app.get("/current-round", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT MAX(round) as maxRound FROM prize");
    const currentRound = rows[0]?.maxRound || 0;
    res.json({ round: currentRound });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching current round" });
  }
});
app.get("/next-round", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT MAX(round) as maxRound FROM lotto");
    const nextRound = (rows[0]?.maxRound || 0) + 1;
    res.json({ round: nextRound });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching next round" });
  }
});



// Get prizes for a specific round
app.get("/prize/:round", async (req, res) => {
  const { round } = req.params;
  try {
    const [rows] = await db.execute("SELECT * FROM prize WHERE round = ?", [round]);
    res.json({ prizes: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching prizes" });
  }
});

// Generate lotto
app.post("/generate", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT MAX(round) as maxRound FROM lotto");
    const round = (rows[0]?.maxRound || 0) + 1;

    if (round > 1) {
      const prevRound = round - 1;
      const [prizeCountResult] = await db.execute("SELECT COUNT(*) as cnt FROM prize WHERE round = ?", [prevRound]);
      if (prizeCountResult[0].cnt === 0) {
        return res.status(400).json({ message: `ยังไม่ได้ออกรางวัลงวดที่ ${prevRound}` });
      }
    }

    const lottoNumbers = await generateLotto(round, 100);
    res.json({ message: `สร้าง Lotto งวด ${round} จำนวน ${lottoNumbers.length} ใบสำเร็จ 🎉`, lottoNumbers, round });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "เกิดข้อผิดพลาดขณะสร้าง Lotto" });
  }
});

// Draw prizes
app.post("/draw-prizes/:round", async (req, res) => {
  const { round } = req.params;
  try {
    const prizes = await drawPrizes(round);
    res.json({ message: `สุ่มรางวัลสำหรับงวดที่ ${round} สำเร็จ`, prizes });
  } catch (e) {
    console.error(e);
    res.status(400).json({ message: e.message }); // ส่ง message จาก Error ที่ throw ไปตรงๆ
  }
});

// My Lotto
app.get("/my-lotto/:cus_id", async (req, res) => {
  const { cus_id } = req.params;
  try {
    const [rows] = await db.execute(
      `SELECT p.purchase_id, l.lotto_id, l.number, p.round, p.purchase_date, p.is_redeemed
       FROM purchase p
       JOIN lotto l ON p.lotto_id = l.lotto_id
       WHERE p.cus_id = ?
       ORDER BY p.round DESC, p.purchase_date DESC`,
      [cus_id]
    );
    res.json({ myLotto: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching my lotto" });
  }
});

// Get available lotto numbers of a round
app.get("/lotto/:round", async (req, res) => {
    const { round } = req.params;
    try {
      const [rows] = await db.execute("SELECT lotto_id, number, price FROM lotto WHERE round = ? AND status = 'available' ORDER BY number ASC", [round]);
      res.json({ lotto: rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Error fetching available lotto" });
    }
  });
  
// Get lastest round that has lotto
app.get("/last-round", async (req, res) => {
    try {
        const [rows] = await db.execute("SELECT MAX(round) as maxRound FROM lotto");
        res.json({ round: rows[0]?.maxRound || 0 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error fetching last round" });
    }
});
app.get("/lotto/all", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT lotto_id, number, round, price, status FROM lotto ORDER BY round DESC, number ASC"
    );
    res.json({ lotto: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching all lotto" });
  }
});



// ------------------- Start server -------------------
connectAndSetupDb().then(() => {
  app.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
  });
});