const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcrypt");
const multer = require("multer");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ✅ Load list of recent chats for sidebar
app.get("/chat-list/:id", (req, res) => {
  const userId = req.params.id;

  const sql = `
    SELECT u.id, u.username, u.profile_pic_url, t.last
    FROM users u
    JOIN (
      SELECT
        CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS other_id,
        MAX(created_at) AS last
      FROM messages
      WHERE sender_id = ? OR receiver_id = ?
      GROUP BY other_id
    ) t ON u.id = t.other_id
    ORDER BY t.last DESC
  `;

  db.query(sql, [userId, userId, userId], (err, results) => {
    if (err) {
      console.error("❌ Error loading chat list:", err);
      return res.status(500).json([]);
    }

    res.json(results);
  });
});


// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());  // ✅ Needed for JSON from fetch()
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));


// --------- FILE UPLOAD SETUP (MULTER) ----------
const uploadDir = path.join(__dirname, "public/uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + file.originalname;
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

// --------- DATABASE ----------
const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "dream2.0",
  database: "messaging_app",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

console.log("✅ MySQL pool initialized!");

const session = require("express-session");

app.use(session({
  secret: "securekey",     // You should change this to a long random string
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day
}));

//---login guard middleware ----
app.use((req, res, next) => {
  if (req.session.user && req.session.user.is_blocked) {
    return res.send("Your account has been blocked by Admin.");
  }
  next();
});


// --------- ROUTES ----------

app.get("/", (req, res) => res.render("home"));

app.get("/login", (req, res) => {
  res.render("login", { errors: [] });
});
app.get("/faq", (req, res) => {
  res.render("faq");
});
app.get("/notifications", (req, res) => {
  res.render("notifications");
});
app.get("/help", (req, res) => {
  res.render("help");
});
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});


// ---------------- LOGIN ----------------

app.post("/login", (req, res) => {
  const { employee_number, password } = req.body;

  db.query(
    "SELECT * FROM users WHERE employee_number = ?",
    [employee_number],
    async (err, results) => {
      if (err) throw err;
      if (results.length === 0)
        return res.render("login", { errors: ["Invalid employee number or password."] });

      const user = results[0];
      const match = await bcrypt.compare(password, user.password_hash);

      if (!match)
        return res.render("login", { errors: ["Invalid employee number or password."] });

      req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        profile_pic_url: user.profile_pic_url
     };



      // If profile not completed
      if (!user.role) {
        return res.redirect(`/complete-profile/${user.id}`);
      }

      // ✅ Load all other employees for popup list
      db.query(
        "SELECT id, username, profile_pic_url FROM users WHERE id != ?",
        [user.id],
        (err, employees) => {
          if (err) throw err;

          db.query("SELECT * FROM chat_groups", (err, groups) => {
    if (err) throw err;

    res.redirect(`/chat/${user.id}`);
     });

        }
      );
    }
  );
});

// ✅ Chat Page Route (loads groups every time)
app.get("/chat/:id", (req, res) => {
  const userId = req.params.id;

  // Load logged user info
  db.query("SELECT * FROM users WHERE id = ?", [userId], (err, userResult) => {
    if (err) throw err;
    if (userResult.length === 0) return res.send("❌ User not found");

    const user = userResult[0];

    // Load all other employees
    db.query(
      "SELECT id, username, profile_pic_url FROM users WHERE id != ?",
      [userId],
      (err, employees) => {
        if (err) throw err;

        // ✅ Load all groups
        db.query("SELECT * FROM chat_groups", (err, groups) => {
          if (err) throw err;

          res.render("chat", { user, employees, groups });
        });
      }
    );
  });
});


// ---------------- REGISTER (STEP 1) ----------------
app.get("/register", (req, res) => {
  res.render("register", { errors: [] });
});

app.post("/register", async (req, res) => {
  const { employee_number, username, email, password, confirm_password } = req.body;
  const errors = [];

  if (!employee_number || !username || !email || !password || !confirm_password) {
    errors.push("All fields are required.");
  }

  if (password !== confirm_password) {
    errors.push("Passwords do not match.");
  }

  if (password.length < 6) {
    errors.push("Password must be at least 6 characters long.");
  }

  if (!/^EMP\d{3}$/.test(employee_number)) {
    errors.push("Employee number must follow EMP001 format.");
  }

  if (errors.length > 0) {
    return res.render("register", { errors });
  }

  // Check if employee_number/email already exists
  db.query(
    "SELECT * FROM users WHERE employee_number = ? OR email = ?",
    [employee_number, email],
    async (err, results) => {
      if (err) {
        return res.render("register", { errors: ["Database error"] });
      }

      if (results.length > 0) {
        return res.render("register", { errors: ["Employee number or email already exists."] });
      }

      try {
        const hashedPassword = await bcrypt.hash(password, 10);

       db.query(
  "INSERT INTO users (employee_number, username, email, password_hash, role, profile_pic_url) VALUES (?, ?, ?, ?, NULL, NULL)",
  [employee_number, username, email, hashedPassword],
  (err, result) => {
    if (err) {
      console.log(err);
      return res.render("register", { errors: ["Error saving user."] });
    }

    const userId = result.insertId;
    console.log("✅ New user registered:", username);

    res.redirect(`/complete-profile/${userId}`);
  }
);
 
      } catch (err) {
        return res.render("register", { errors: ["Error processing password."] });
      }
    }
  );
});

// ------------- COMPLETE PROFILE (STEP 2) -------------

// ✅ ADD THIS GET ROUTE HERE
app.get("/complete-profile/:id", (req, res) => {
  const userId = req.params.id;

  db.query("SELECT * FROM users WHERE id = ?", [userId], (err, results) => {
    if (err) throw err;

    if (results.length === 0) {
      return res.send("❌ Invalid profile link. User not found.");
    }

    res.render("complete-profile", { userId, errors: [] });
  });
});

// ✅ THEN THIS POST ROUTE
app.post("/complete-profile/:id", upload.single("profile_pic"), (req, res) => {
  const { role } = req.body;
  const userId = req.params.id;
  const profilePic = req.file ? `/uploads/${req.file.filename}` : null;

  if (!role) {
    return res.render("complete-profile", {
      userId,
      errors: ["Please select your role."],
    });
  }

  db.query(
    "UPDATE users SET role = ?, profile_pic_url = ? WHERE id = ?",
    [role, profilePic, userId],
    err => {
      if (err) throw err;

      console.log(`✅ User ${userId} completed their profile.`);
      res.redirect("/login");
    }
  );
});

// ✅ Create Group (Admin, HR)
app.post("/create-group", (req, res) => {
  const { group_name, created_by } = req.body;

  db.query("SELECT role FROM users WHERE id = ?", [created_by], (err, result) => {
    if (err) throw err;

    const role = result[0].role;

    if (!["Admin", "HR"].includes(role)) {
      return res.status(403).send("❌ You are not allowed to create groups.");
    }

    // ✅ Create group
    db.query(
      "INSERT INTO chat_groups (group_name, created_by) VALUES (?, ?)",
      [group_name, created_by],
      (err, result) => {
        if (err) throw err;

        const groupId = result.insertId;

        // ✅ Add creator to group
        db.query(
          "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
          [groupId, created_by]
        );

        res.send("✅ Group created successfully!");
      }
    );
  });
});

// ✅ Get Group Members
app.get("/group-members/:groupId", (req, res) => {
  const { groupId } = req.params;

  db.query(
    `SELECT u.id, u.username, u.profile_pic_url
     FROM group_members gm
     JOIN users u ON gm.user_id = u.id
     WHERE gm.group_id = ?`,
    [groupId],
    (err, results) => {
      if (err) throw err;
      res.json(results);
    }
  );
});

// ✅ Add Member to Group (Admin/HR)
app.post("/add-group-member", (req, res) => {
  const { group_id, user_id, added_by } = req.body;

  db.query("SELECT role FROM users WHERE id = ?", [added_by], (err, result) => {
    if (err) throw err;
    const role = result[0].role;

    if (!["Admin", "HR"].includes(role)) {
      return res.status(403).send("❌ You are not allowed to add members.");
    }

    db.query(
      "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
      [group_id, user_id],
      err => {
        if (err) throw err;
        res.send("✅ Member added to group!");
      }
    );
  });
});

// ✅ Remove Member from Group (Admin/HR)
app.post("/remove-group-member", (req, res) => {
  const { group_id, user_id, removed_by } = req.body;

  db.query("SELECT role FROM users WHERE id = ?", [removed_by], (err, result) => {
    if (err) throw err;
    const role = result[0].role;

    if (!["Admin", "HR"].includes(role)) {
      return res.status(403).send("❌ You are not allowed to remove members.");
    }

    db.query(
      "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
      [group_id, user_id],
      err => {
        if (err) throw err;
        res.send("✅ Member removed from group!");
      }
    );
  });
});


let onlineUsers = {};

// ✅ Load chat history
app.get("/messages/:sender/:receiver", (req, res) => {
  const { sender, receiver } = req.params;

  db.query(
    `SELECT * FROM messages
     WHERE 
       (sender_id = ? AND receiver_id = ?)
       OR
       (sender_id = ? AND receiver_id = ?)
     ORDER BY created_at ASC`,
    [sender, receiver, receiver, sender],
    (err, results) => {
      if (err) throw err;
      res.json(results);
    }
  );
});

// ✅ Load group message history
app.get("/group-messages/:group_id", (req, res) => {
  const { group_id } = req.params;

  db.query(
    "SELECT * FROM messages WHERE group_id = ? ORDER BY created_at ASC",
    [group_id],
    (err, results) => {
      if (err) throw err;
      res.json(results);
    }
  );
});

app.post("/uploadStatus", upload.single("statusFile"), (req, res) => {
    const file = "/uploads/" + req.file.filename;
    const userId = req.session.user.id;

    db.query(
        "INSERT INTO statuses (user_id, media_url, caption, created_at, expires_at) VALUES (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 24 HOUR))",
        [userId, file, req.body.caption || null],
        () => res.redirect("/status")
    );
});


app.get("/status", (req, res) => {
    if (!req.session.user) {
        return res.redirect("/login");
    }

    const userId = req.session.user.id;

    db.query("SELECT * FROM users WHERE id=?", [userId], (err, userRows) => {
        if (err) throw err;

        db.query(
            "SELECT s.*, u.username, u.profile_pic_url FROM statuses s JOIN users u ON s.user_id = u.id ORDER BY s.posted_at DESC",
            (err2, statusRows) => {
                if (err2) throw err2;

                res.render("status", {
                    user: userRows[0],
                    statuses: statusRows
                });
            }
        );
    });
});

// ------------- profile -------------

app.get("/profile", isLoggedIn, (req, res) => {
  const userId = req.session.user.id;

  db.query("SELECT * FROM users WHERE id = ?", [userId], (err, results) => {
    if (err) {
      console.error(err);
      return res.redirect("/login");
    }

    if (results.length === 0) {
      return res.redirect("/login");
    }

    res.render("profile", {
      user: results[0]
    });
  });
});

function isLoggedIn(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
}


app.post("/update-profile", isLoggedIn, (req, res) => {
  const { username, email } = req.body;
  const userId = req.session.user.id;

  const sql = "UPDATE users SET username = ?, email = ? WHERE id = ?";

  db.query(sql, [username, email, userId], err => {
    if (err) {
      console.error(err);
      return res.send("Error updating profile");
    }

    // 🔁 Update session data
    req.session.user.username = username;

    res.redirect("/profile");
  });
});

app.post(
  "/upload-avatar",
  isLoggedIn,
  upload.single("avatar"),
  (req, res) => {
    if (!req.file) return res.redirect("/profile");

    const avatarPath = "/uploads/" + req.file.filename;
    const userId = req.session.user.id;

    db.query(
      "UPDATE users SET profile_pic_url = ? WHERE id = ?",
      [avatarPath, userId],
      err => {
        if (err) {
          console.error(err);
          return res.redirect("/profile");
        }

        // 🔁 update session
        req.session.user.profile_pic_url = avatarPath;

        res.redirect("/profile");
      }
    );
  }
);
// File upload rout

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded.");

  const userId = req.session.userId;
  const filename = req.file.filename;
  const originalname = req.file.originalname;

  db.query(
    "INSERT INTO files (user_id, filename, originalname) VALUES (?, ?, ?)",
    [userId, filename, originalname],
    (err, result) => {
      if (err) return res.status(500).send("DB error");

      // Return JSON with file info
      res.json({
        filename,
        originalname,
        url: `/uploads/${filename}`
      });
    }
  );
});

// Show feedback page
app.get("/feedback", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  res.render("feedback", {
    user: req.session.user
  });
});

// Submit feedback
app.post("/feedback", (req, res) => {
  const { recipient_role, subject, message } = req.body;
  const sender_id = req.session.user.id;

  if (!recipient_role || !subject || !message) {
    return res.send("All fields required");
  }

  const sql = `
    INSERT INTO feedback (sender_id, recipient_role, subject, message)
    VALUES (?, ?, ?, ?)
  `;

  db.query(sql, [sender_id, recipient_role, subject, message], err => {
    if (err) throw err;
    res.send("Feedback sent successfully");
  });
});

app.get("/feedback-inbox", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const role = req.session.user.role;

  // Only Admin & HR allowed
  if (!["Admin", "HR"].includes(role)) {
    return res.send("Access denied");
  }

  const sql = `
    SELECT f.*, u.username 
    FROM feedback f
    JOIN users u ON f.sender_id = u.id
    WHERE f.recipient_role = ?
    ORDER BY f.created_at DESC
  `;

  db.query(sql, [role], (err, feedback) => {
    if (err) throw err;
    res.render("feedback-inbox", {
      user: req.session.user,
      feedback
    });
  });
});

//-------admin user management route ---------
app.get("/admin/users", requireAdmin, (req, res) => {
  db.query(
    "SELECT id, username, email, role, is_blocked, created_at FROM users ORDER BY created_at DESC",
    (err, users) => {
      if (err) throw err;
      res.render("admin-users", {
        user: req.session.user,
        users
      });
    }
  );
});
// Middleware to check for Admin role
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "Admin") {
    return res.status(403).send("Access denied");
  }
  next();
}
//----block/unblock user -----
app.post("/admin/block-user", requireAdmin, (req, res) => {
  const { user_id, block } = req.body;

  db.query(
    "UPDATE users SET is_blocked=? WHERE id=?",
    [block ? 1 : 0, user_id],
    err => {
      if (err) throw err;
      res.redirect("/admin/users");
    }
  );
});
//----delete user -----
app.post("/admin/delete-user", requireAdmin, (req, res) => {
  const { user_id } = req.body;

  // Prevent admin from deleting self
  if (user_id == req.session.user.id) {
    return res.send("You cannot delete yourself");
  }

  db.query(
    "DELETE FROM users WHERE id=?",
    [user_id],
    err => {
      if (err) throw err;
      res.redirect("/admin/users");
    }
  );
});



// ------------- SOCKET.IO CHAT -------------

// ✅ Real-time chat system
io.on("connection", socket => {
  console.log("💬 User connected:", socket.id);

  // ✅ User becomes online
  socket.on("user_online", userId => {
    onlineUsers[userId] = socket.id;
    io.emit("online_users", onlineUsers);
  });

  // ✅ Save and deliver messages
  socket.on("chat message", data => {
    const { sender, receiver, message } = data;

    // Save message + set delivered = 1
    db.query(
      "INSERT INTO messages (sender_id, receiver_id, message, is_delivered) VALUES (?, ?, ?, 1)",
      [sender, receiver, message],
      (err, result) => {
        if (err) throw err;

        const messageId = result.insertId;

        // ✅ If receiver is online → send message directly
        if (onlineUsers[receiver]) {
          io.to(onlineUsers[receiver]).emit("chat message", {
            id: messageId,
            sender,
            receiver,
            message,
            is_delivered: 1,
            is_seen: 0
          });
        }

        // ✅ Always return message to sender
        io.to(onlineUsers[sender]).emit("chat message", {
          id: messageId,
          sender,
          receiver,
          message,
          is_delivered: 1,
          is_seen: 0
        });
      }
    );
  });

  // ✅ GROUP MESSAGE handler
socket.on("group message", data => {
  const { sender, group_id, message } = data;

  db.query(
    "INSERT INTO messages (sender_id, group_id, message, is_delivered) VALUES (?, ?, ?, 1)",
    [sender, group_id, message],
    (err, result) => {
      if (err) throw err;

      const msgId = result.insertId;

      // ✅ Send message to ALL online users (no receiver needed)
      io.emit("group message", {
        id: msgId,
        sender,
        group_id,
        message,
        is_delivered: 1
      });
    }
  );
});


  // ✅ Mark messages as seen
  socket.on("mark_seen", ({ sender, receiver }) => {
    db.query(
      "UPDATE messages SET is_seen = 1 WHERE sender_id = ? AND receiver_id = ?",
      [sender, receiver]
    );

    // Notify sender that messages are seen
    if (onlineUsers[sender]) {
      io.to(onlineUsers[sender]).emit("messages_seen", { receiver });
    }
  });

  // ✅ On user disconnect
  socket.on("disconnect", () => {
    for (let id in onlineUsers) {
      if (onlineUsers[id] === socket.id) {
        delete onlineUsers[id];
      }
    }
    io.emit("online_users", onlineUsers);
    console.log("❌ User disconnected:", socket.id);
  });
});


// ------------- SERVER -------------
server.listen(3000, () =>
  console.log("🚀 Server running on http://localhost:3000")
);
