require("dotenv").config();

const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 25);
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const productionDb = Boolean(process.env.DATABASE_URL);
let sqlite = null;
let pgPool = null;

if (productionDb) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
  });
} else {
  sqlite = new Database(path.join(DATA_DIR, "notes.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      roll_no TEXT, branch TEXT, semester TEXT,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, code TEXT, branch TEXT, semester TEXT,
      UNIQUE(name, branch, semester)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      subject_id INTEGER,
      title TEXT NOT NULL, subject TEXT NOT NULL, semester TEXT,
      description TEXT, original_name TEXT NOT NULL, storage_path TEXT NOT NULL,
      mime_type TEXT NOT NULL, file_size INTEGER NOT NULL, downloads INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS otp_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE,
      code_hash TEXT NOT NULL, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL, note_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id, note_id)
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, note_id INTEGER,
      title TEXT NOT NULL, remind_at TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS note_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT, category TEXT, tags TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS note_shares (
      note_id INTEGER NOT NULL, shared_by INTEGER NOT NULL, shared_with TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'view', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(note_id, shared_with)
    );
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL,
      note_id INTEGER, metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_by INTEGER, label TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (const statement of [
    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student'",
    "ALTER TABLE notes ADD COLUMN category TEXT NOT NULL DEFAULT 'study-material'",
    "ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'class'",
    "ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"
  ]) {
    try { sqlite.exec(statement); } catch (e) {
      if (!String(e.message).includes("duplicate column")) throw e;
    }
  }
  const seed = [
    ["Data Structures & Algorithms","CSE-301","CSE","3rd Semester"],
    ["Object Oriented Programming","CSE-302","CSE","3rd Semester"],
    ["Database Management Systems","CSE-401","CSE","4th Semester"],
    ["Computer Networks","CSE-402","CSE","4th Semester"],
    ["Operating Systems","CSE-403","CSE","4th Semester"],
    ["Microprocessors","CSE-304","CSE","3rd Semester"],
    ["Cyber Security","CSE-405","CSE","5th Semester"],
    ["Engineering Mathematics","MATH-101","All","1st Semester"],
    ["Engineering Physics","PHY-101","All","1st Semester"],
    ["Engineering Chemistry","CHEM-101","All","1st Semester"]
  ];
  for (const s of seed) sqlite.prepare(
    "INSERT OR IGNORE INTO subjects(name,code,branch,semester) VALUES(?,?,?,?)"
  ).run(...s);
}

function configured(value, placeholders = []) {
  const text = String(value || "").trim();
  return Boolean(text) && !placeholders.includes(text) && !placeholders.some((placeholder) => text.includes(placeholder));
}

const supabase = configured(process.env.SUPABASE_URL, ["YOUR_PROJECT.supabase.co"]) &&
  configured(process.env.SUPABASE_SERVICE_ROLE_KEY, ["YOUR_SERVER_ONLY_SERVICE_ROLE_KEY"])
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

async function all(sql, params = []) {
  if (productionDb) {
    const r = await pgPool.query(sql.replace(/\?/g, () => `$${params._i = (params._i || 0) + 1}`), params);
    delete params._i;
    return r.rows;
  }
  return sqlite.prepare(sql).all(...params);
}

async function get(sql, params = []) {
  if (productionDb) {
    const r = await pgPool.query(sql.replace(/\?/g, () => `$${params._i = (params._i || 0) + 1}`), params);
    delete params._i;
    return r.rows[0];
  }
  return sqlite.prepare(sql).get(...params);
}

async function run(sql, params = []) {
  if (productionDb) {
    const r = await pgPool.query(sql.replace(/\?/g, () => `$${params._i = (params._i || 0) + 1}`), params);
    delete params._i;
    return { rowCount: r.rowCount, rows: r.rows };
  }
  const info = sqlite.prepare(sql).run(...params);
  return { rowCount: info.changes, lastInsertRowid: info.lastInsertRowid, rows: [] };
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(ROOT, "public")));

const allowedTypes = new Set([
  "application/pdf","image/jpeg","image/png","image/webp","image/gif","text/plain",
  "application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint","application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(18).toString("hex") + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => allowedTypes.has(file.mimetype) ? cb(null, true) : cb(new Error("File type is not allowed."))
});

let transporter = null;
if (configured(process.env.SMTP_HOST) &&
    configured(process.env.SMTP_USER, ["your-email@gmail.com"]) &&
    configured(process.env.SMTP_PASS, ["your-16-character-gmail-app-password"])) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function emailOk(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  const domain = String(process.env.ALLOWED_EMAIL_DOMAIN || "").trim().toLowerCase();
  return !domain || email.endsWith("@" + domain);
}
function cleanEmail(e) { return String(e || "").trim().toLowerCase(); }
function otp() { return String(crypto.randomInt(100000, 1000000)); }

async function sendOtp(email, code, purpose) {
  if (!transporter) {
    console.log(`[DEV OTP] ${email}: ${code}`);
    return false;
  }
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: purpose === "register" ? "SLIET Notes Portal â€” Verify account" : "SLIET Notes Portal â€” Login code",
    html: `<div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;padding:28px">
      <h2>SLIET Notes Portal</h2><p>Your verification code is:</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f3f5f9;border-radius:14px;padding:18px;text-align:center">${code}</div>
      <p>This code expires in 10 minutes.</p></div>`
  });
  return true;
}
async function createOtp(email, purpose) {
  const code = otp();
  const hash = bcrypt.hashSync(code, 10);
  const expires = Date.now() + 10 * 60 * 1000;
  await run("DELETE FROM otp_codes WHERE email = ?", [email]);
  await run("INSERT INTO otp_codes(email,code_hash,purpose,expires_at) VALUES(?,?,?,?)", [email,hash,purpose,expires]);
  return code;
}
function requireStudent(req,res,next) {
  if (!req.session.userId || req.session.admin) return res.status(401).json({error:"Student login required."});
  next();
}
function requireAdmin(req,res,next) {
  if (!req.session.admin) return res.status(401).json({error:"Admin login required."});
  next();
}
function publicNote(r, uid) {
  return {
    id:r.id,title:r.title,subject:r.subject,semester:r.semester,description:r.description,
    original_name:r.original_name,mime_type:r.mime_type,file_size:Number(r.file_size || 0),
    downloads:r.downloads,uploader_name:r.uploader_name,uploader_email:r.uploader_email,
    created_at:r.created_at,category:r.category||"study-material",tags:r.tags||"",
    visibility:r.visibility||"class",archived:Boolean(r.archived),
    is_favorite:Boolean(r.is_favorite),is_mine:String(r.user_id)===String(uid)
  };
}
function logActivity(userId, action, noteId = null, metadata = {}) {
  return run("INSERT INTO activity_logs(user_id,action,note_id,metadata) VALUES(?,?,?,?)",
    [userId || null, action, noteId, JSON.stringify(metadata)]);
}
function requireFacultyOrAdmin(req, res, next) {
  if (req.session.admin || req.session.role === "faculty") return next();
  return res.status(403).json({error:"Faculty or administrator permission required."});
}
function storageEnabled() { return Boolean(supabase); }

app.get("/api/config", (_req,res) => res.json({
  college: "Sant Longowal Institute of Engineering & Technology",
  shortName: "SLIET",
  location: "Longowal, Sangrur, Punjab",
  productionDb,
  cloudStorage: storageEnabled()
}));

app.post("/api/auth/register", async (req,res) => {
  try {
    const name=String(req.body.name||"").trim(), email=cleanEmail(req.body.email);
    const roll=String(req.body.rollNo||"").trim(), branch=String(req.body.branch||"").trim(), semester=String(req.body.semester||"").trim();
    if(name.length<2) return res.status(400).json({error:"Enter your full name."});
    if(!emailOk(email)) return res.status(400).json({error:"Enter a valid email address"+(process.env.ALLOWED_EMAIL_DOMAIN?` from @${process.env.ALLOWED_EMAIL_DOMAIN}.`:"." )});
    let u=await get("SELECT * FROM users WHERE email = ?",[email]);
    if(u && u.verified) return res.status(409).json({error:"Account already exists. Use Student Login."});
    if(u) await run("UPDATE users SET name=?,roll_no=?,branch=?,semester=? WHERE id=?",[name,roll,branch,semester,u.id]);
    else await run("INSERT INTO users(name,email,roll_no,branch,semester) VALUES(?,?,?,?,?)",[name,email,roll,branch,semester]);
    const code=await createOtp(email,"register"); await sendOtp(email,code,"register");
    res.json({ok:true,message:transporter?"Verification code sent to your email.":"Development OTP generated. Use the code shown below.",devOtp:transporter?undefined:code});
  } catch(e) {
    console.error(e);
    res.status(502).json({error:e.message||"Could not send verification email."});
  }
});

async function verifyOtp(req,res,purpose) {
  const email=cleanEmail(req.body.email), code=String(req.body.code||"").trim();
  const u=await get("SELECT * FROM users WHERE email = ?",[email]);
  const o=await get("SELECT * FROM otp_codes WHERE email = ? ORDER BY id DESC LIMIT 1",[email]);
  if(!u || !o || o.purpose!==purpose) return res.status(400).json({error:"Verification code is invalid."});
  if(Date.now()>Number(o.expires_at)) { await run("DELETE FROM otp_codes WHERE id=?",[o.id]); return res.status(400).json({error:"Code expired. Request a new code."}); }
  if(Number(o.attempts)>=5) return res.status(429).json({error:"Too many attempts. Request a new code."});
  if(!bcrypt.compareSync(code,o.code_hash)) { await run("UPDATE otp_codes SET attempts=attempts+1 WHERE id=?",[o.id]); return res.status(400).json({error:"Incorrect verification code."}); }
  if(purpose==="register") await run("UPDATE users SET verified=? WHERE id=?",[productionDb?true:1,u.id]);
  await run("DELETE FROM otp_codes WHERE id=?",[o.id]);
  req.session.userId=u.id; req.session.admin=false; req.session.role=u.role||"student";
  res.json({ok:true,user:{id:u.id,name:u.name,email:u.email,rollNo:u.roll_no,branch:u.branch,semester:u.semester,createdAt:u.created_at,role:u.role||"student"}});
}
app.post("/api/auth/verify-registration",(req,res)=>verifyOtp(req,res,"register"));

app.post("/api/auth/request-login", async (req,res)=>{
  try {
    const email=cleanEmail(req.body.email);
    if(!emailOk(email)) return res.status(400).json({error:"Enter a valid email address."});
    const u=await get("SELECT * FROM users WHERE email = ?",[email]);
    if(!u || !u.verified) return res.status(404).json({error:"No verified student account found for this email."});
    const code=await createOtp(email,"login"); await sendOtp(email,code,"login");
    res.json({ok:true,message:transporter?"Login code sent to your email.":"Development OTP generated. Use the code shown below.",devOtp:transporter?undefined:code});
  } catch(e) {
    console.error(e);
    res.status(502).json({error:e.message||"Could not send login email."});
  }
});
app.post("/api/auth/verify-login",(req,res)=>verifyOtp(req,res,"login"));

app.post("/api/auth/admin-login",(req,res)=>{
  const email=cleanEmail(req.body.email), password=String(req.body.password||"");
  if(email!==cleanEmail(process.env.ADMIN_EMAIL||"") || password!==(process.env.ADMIN_PASSWORD||""))
    return res.status(401).json({error:"Invalid admin credentials."});
  req.session.admin=true; req.session.role="admin"; req.session.userId=null; res.json({ok:true});
});
app.post("/api/auth/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/auth/me", async (req,res)=>{
  if(req.session.admin) return res.json({authenticated:true,admin:true});
  if(!req.session.userId) return res.json({authenticated:false});
  const u=await get("SELECT id,name,email,roll_no,branch,semester,created_at,role FROM users WHERE id=?",[req.session.userId]);
  if(!u) return res.json({authenticated:false});
  res.json({authenticated:true,admin:false,role:u.role||"student",user:{id:u.id,name:u.name,email:u.email,rollNo:u.roll_no,branch:u.branch,semester:u.semester,createdAt:u.created_at}});
});

app.get("/api/subjects",requireStudent,async(req,res)=>{
  const branch=String(req.query.branch||"").trim(), semester=String(req.query.semester||"").trim();
  let sql="SELECT * FROM subjects WHERE 1=1", p=[];
  if(semester){sql+=" AND semester=?";p.push(semester);}
  if(branch){sql+=" AND (branch=? OR branch='All')";p.push(branch);}
  sql+=" ORDER BY semester,name";
  res.json({subjects:await all(sql,p)});
});
app.get("/api/faculty-members",requireStudent,async(req,res)=>{
  const branch=String(req.query.branch||"").trim();
  let sql="SELECT id,name,email,branch,semester,created_at FROM users WHERE verified=? AND role='faculty'", p=[productionDb?true:1];
  if(branch){sql+=" AND (branch=? OR branch IS NULL OR branch='')";p.push(branch);}
  sql+=" ORDER BY name";
  res.json({faculty:await all(sql,p)});
});

app.get("/api/notes",requireStudent,async(req,res)=>{
  const q=String(req.query.q||"").trim(), subject=String(req.query.subject||"").trim(), semester=String(req.query.semester||"").trim(), branch=String(req.query.branch||"").trim();
  let sql=`SELECT n.*,u.name uploader_name,u.email uploader_email,u.branch uploader_branch,
           CASE WHEN f.user_id IS NULL THEN 0 ELSE 1 END is_favorite
           FROM notes n JOIN users u ON u.id=n.user_id
           LEFT JOIN favorites f ON f.note_id=n.id AND f.user_id=? WHERE 1=1`, p=[req.session.userId];
  if(q){sql+=" AND (n.title LIKE ? OR n.subject LIKE ? OR n.description LIKE ? OR u.name LIKE ?)";const x=`%${q}%`;p.push(x,x,x,x);}
  if(subject){sql+=" AND n.subject=?";p.push(subject);}
  if(semester){sql+=" AND n.semester=?";p.push(semester);}
  if(branch){sql+=" AND (u.branch=? OR u.branch IS NULL OR u.branch='')";p.push(branch);}
  if(req.query.category){sql+=" AND n.category=?";p.push(String(req.query.category));}
  if(req.query.tag){sql+=" AND n.tags LIKE ?";p.push(`%${String(req.query.tag)}%`);}
  if(req.query.favorites==="1") sql+=" AND f.user_id IS NOT NULL";
  sql+=" AND n.archived="+(productionDb?"false":"0")+" ORDER BY "+(req.query.sort==="oldest"?"n.id ASC":"n.id DESC");
  const rows=await all(sql,p); res.json({notes:rows.map(x=>publicNote(x,req.session.userId))});
});

app.get("/api/dashboard",requireStudent,async(req,res)=>{
  const my=await get("SELECT COUNT(*) count FROM notes WHERE user_id=?",[req.session.userId]);
  const dl=await get("SELECT COALESCE(SUM(downloads),0) count FROM notes WHERE user_id=?",[req.session.userId]);
  const users=await get("SELECT COUNT(*) count FROM users WHERE verified=?",[productionDb?true:1]);
  const notes=await get("SELECT COUNT(*) count FROM notes",[]);
  const recent=await all(`SELECT n.*,u.name uploader_name,u.email uploader_email FROM notes n JOIN users u ON u.id=n.user_id ORDER BY n.id DESC LIMIT 6`);
  res.json({totalNotes:Number(my.count),myDownloads:Number(dl.count),totalStudents:Number(users.count),totalAllNotes:Number(notes.count),recent:recent.map(x=>publicNote(x,req.session.userId))});
});

app.post("/api/notes",requireStudent,upload.single("file"),async(req,res)=>{
  let file=req.file;
  try{
    if(!file) return res.status(400).json({error:"Please select a file."});
    const title=String(req.body.title||"").trim(), subject=String(req.body.subject||"").trim();
    const semester=String(req.body.semester||"").trim(), description=String(req.body.description||"").trim();
    const branch=String(req.body.branch||"").trim();
    const category=String(req.body.category||"study-material").trim();
    const tags=String(req.body.tags||"").trim();
    const visibility=String(req.body.visibility||"class").trim();
    if(!title||!subject){fs.unlinkSync(file.path);return res.status(400).json({error:"Title and subject are required."});}

    let storagePath=file.filename;
    if(storageEnabled()){
      storagePath=`${req.session.userId}/${Date.now()}-${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname).toLowerCase()}`;
      const body=fs.readFileSync(file.path);
      const {error}=await supabase.storage.from(process.env.SUPABASE_BUCKET||"notes").upload(storagePath,body,{
        contentType:file.mimetype,upsert:false,cacheControl:"3600"
      });

      if(error) throw new Error("Cloud upload failed: "+error.message);
      fs.unlinkSync(file.path);
    }

    let subjectRow=await get("SELECT id FROM subjects WHERE name=? AND semester=? LIMIT 1",[subject,semester]);
    const subjectId=subjectRow?.id || null;
    if(productionDb){
      const r=await pgPool.query(
        `INSERT INTO notes(user_id,subject_id,title,subject,semester,description,original_name,storage_path,mime_type,file_size,category,tags,visibility)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [req.session.userId,subjectId,title,subject,semester,description,file.originalname,storagePath,file.mimetype,file.size,category,tags,visibility]
      );
      return res.json({ok:true,id:r.rows[0].id});
    }
    const r=await run("INSERT INTO notes(user_id,subject_id,title,subject,semester,description,original_name,storage_path,mime_type,file_size,category,tags,visibility) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [req.session.userId,subjectId,title,subject,semester,description,file.originalname,storagePath,file.mimetype,file.size,category,tags,visibility]);
    await logActivity(req.session.userId,"note_created",r.lastInsertRowid,{category});
    res.json({ok:true,id:r.lastInsertRowid});
  }catch(e){
    if(file?.path&&fs.existsSync(file.path)) fs.unlinkSync(file.path);
    console.error(e); res.status(500).json({error:e.message||"Upload failed."});
  }
});

      app.post("/api/notes/:id/favorite",requireStudent,async(req,res)=>{
        const note=await get("SELECT id FROM notes WHERE id=?",[req.params.id]);
        if(!note)return res.status(404).json({error:"Note not found."});
        const existing=await get("SELECT 1 FROM favorites WHERE user_id=? AND note_id=?",[req.session.userId,note.id]);
        if(existing) await run("DELETE FROM favorites WHERE user_id=? AND note_id=?",[req.session.userId,note.id]);
        else await run("INSERT INTO favorites(user_id,note_id) VALUES(?,?)",[req.session.userId,note.id]);
        await logActivity(req.session.userId,existing?"favorite_removed":"favorite_added",note.id);
        res.json({ok:true,favorite:!existing});
      });
      app.get("/api/reminders",requireStudent,async(req,res)=>{
        res.json({reminders:await all("SELECT * FROM reminders WHERE user_id=? ORDER BY remind_at",[req.session.userId])});
      });
      app.post("/api/reminders",requireStudent,async(req,res)=>{
        const title=String(req.body.title||"").trim(), remindAt=String(req.body.remindAt||"").trim();
        if(!title||!remindAt)return res.status(400).json({error:"Reminder title and date are required."});
        const r=await run("INSERT INTO reminders(user_id,note_id,title,remind_at) VALUES(?,?,?,?)",
          [req.session.userId,req.body.noteId||null,title,remindAt]);
        res.json({ok:true,id:r.lastInsertRowid});
      });
      app.patch("/api/reminders/:id",requireStudent,async(req,res)=>{
        await run("UPDATE reminders SET completed=? WHERE id=? AND user_id=?",
          [req.body.completed?1:0,req.params.id,req.session.userId]);
        res.json({ok:true});
      });
      app.post("/api/notes/:id/archive",requireStudent,async(req,res)=>{
        const n=await get("SELECT * FROM notes WHERE id=? AND user_id=?",[req.params.id,req.session.userId]);
        if(!n)return res.status(404).json({error:"Note not found."});
        await run("UPDATE notes SET archived=? WHERE id=?",[n.archived?0:1,n.id]);
        await logActivity(req.session.userId,n.archived?"note_restored":"note_archived",n.id);
        res.json({ok:true,archived:!n.archived});
      });
      app.get("/api/notes/:id/versions",requireStudent,async(req,res)=>{
        const n=await get("SELECT * FROM notes WHERE id=?",[req.params.id]);
        if(!n)return res.status(404).json({error:"Note not found."});
        res.json({versions:await all("SELECT * FROM note_versions WHERE note_id=? ORDER BY id DESC",[n.id])});
      });
      app.post("/api/notes/:id/share",requireStudent,async(req,res)=>{
        const n=await get("SELECT * FROM notes WHERE id=? AND user_id=?",[req.params.id,req.session.userId]);
        const sharedWith=cleanEmail(req.body.email||req.body.group);
        const permission=req.body.permission==="edit"?"edit":"view";
        if(!n||!sharedWith)return res.status(400).json({error:"Note and recipient are required."});
        if (productionDb) {
          await run("DELETE FROM note_shares WHERE note_id=? AND shared_with=?",[n.id,sharedWith]);
        }
        await run(productionDb
          ? "INSERT INTO note_shares(note_id,shared_by,shared_with,permission) VALUES(?,?,?,?)"
          : "INSERT OR REPLACE INTO note_shares(note_id,shared_by,shared_with,permission) VALUES(?,?,?,?)",
          [n.id,req.session.userId,sharedWith,permission]);
        await logActivity(req.session.userId,"note_shared",n.id,{sharedWith,permission});
        res.json({ok:true});
      });
      app.get("/api/stats/overview",requireFacultyOrAdmin,async(req,res)=>{
        const [notes,users,downloads,categories,activity]=await Promise.all([
          get("SELECT COUNT(*) count FROM notes",[]),
          get("SELECT COUNT(*) count FROM users",[]),
          get("SELECT COALESCE(SUM(downloads),0) count FROM notes",[]),
          all("SELECT category,COUNT(*) count FROM notes GROUP BY category ORDER BY count DESC",[]),
          all("SELECT action,COUNT(*) count FROM activity_logs GROUP BY action ORDER BY count DESC",[])
        ]);
        const files=await all("SELECT file_size FROM notes",[]);
        res.json({notes:Number(notes.count),users:Number(users.count),downloads:Number(downloads.count),
          storageBytes:files.reduce((s,x)=>s+Number(x.file_size||0),0),categories,activity});
      });
      app.get("/api/admin/users",requireAdmin,async(_req,res)=>{
        const rows=await all(`SELECT u.*,COUNT(n.id) notes_count FROM users u LEFT JOIN notes n ON n.user_id=u.id GROUP BY u.id ORDER BY u.id DESC`);
        res.json({users:rows});
      });
      app.patch("/api/admin/users/:id/role",requireAdmin,async(req,res)=>{
        const role=["student","faculty","admin"].includes(req.body.role)?req.body.role:"student";
        await run("UPDATE users SET role=? WHERE id=?",[role,req.params.id]);
        res.json({ok:true,role});
      });
      app.post("/api/admin/backups",requireAdmin,async(req,res)=>{
        const rows=await all("SELECT file_size FROM notes",[]);
        const r=await run("INSERT INTO backups(created_by,label,file_count,size_bytes) VALUES(?,?,?,?)",
          [null,String(req.body.label||"Manual backup"),rows.length,rows.reduce((s,x)=>s+Number(x.file_size||0),0)]);
        res.json({ok:true,id:r.lastInsertRowid});
      });
      app.get("/api/admin/backups",requireAdmin,async(_req,res)=>res.json({backups:await all("SELECT * FROM backups ORDER BY id DESC",[])}));
app.get("/api/notes/:id/file",requireStudent,async(req,res)=>{
  const n=await get("SELECT * FROM notes WHERE id=?",[req.params.id]);
  if(!n)return res.status(404).send("Note not found.");
  if(storageEnabled()){
    const {data,error}=await supabase.storage.from(process.env.SUPABASE_BUCKET||"notes").createSignedUrl(n.storage_path,60*10);
    if(error)return res.status(404).send("File unavailable.");
    return res.redirect(data.signedUrl);
  }
  const fp=path.join(UPLOAD_DIR,n.storage_path);
  if(!fs.existsSync(fp))return res.status(404).send("File missing.");
  res.setHeader("Content-Type",n.mime_type); res.sendFile(fp);
});

app.get("/api/notes/:id/download",requireStudent,async(req,res)=>{
  const n=await get("SELECT * FROM notes WHERE id=?",[req.params.id]);
  if(!n)return res.status(404).send("Note not found.");
  await run("UPDATE notes SET downloads=downloads+1 WHERE id=?",[n.id]);
  if(storageEnabled()){
    const {data,error}=await supabase.storage.from(process.env.SUPABASE_BUCKET||"notes").createSignedUrl(n.storage_path,60*10,{download:n.original_name});
    if(error)return res.status(404).send("File unavailable.");
    return res.redirect(data.signedUrl);
  }
  const fp=path.join(UPLOAD_DIR,n.storage_path);
  if(!fs.existsSync(fp))return res.status(404).send("File missing.");
  res.download(fp,n.original_name);
});

async function deleteStorage(filePath){
  if(!filePath)return;
  if(storageEnabled()) await supabase.storage.from(process.env.SUPABASE_BUCKET||"notes").remove([filePath]);
  else {const p=path.join(UPLOAD_DIR,filePath);if(fs.existsSync(p))fs.unlinkSync(p);}
}
app.delete("/api/notes/:id",requireStudent,async(req,res)=>{
  const n=await get("SELECT * FROM notes WHERE id=? AND user_id=?",[req.params.id,req.session.userId]);
  if(!n)return res.status(404).json({error:"Note not found."});
  await deleteStorage(n.storage_path); await run("DELETE FROM notes WHERE id=?",[n.id]); res.json({ok:true});
});

app.get("/api/admin/stats",requireAdmin,async(_req,res)=>{
  const u=await get("SELECT COUNT(*) count FROM users WHERE verified=?",[productionDb?true:1]);
  const n=await get("SELECT COUNT(*) count FROM notes");
  const d=await get("SELECT COALESCE(SUM(downloads),0) count FROM notes");
  res.json({users:Number(u.count),notes:Number(n.count),downloads:Number(d.count)});
});
app.get("/api/admin/users",requireAdmin,async(_req,res)=>{
  const rows=await all(`SELECT u.*,COUNT(n.id) notes_count FROM users u LEFT JOIN notes n ON n.user_id=u.id GROUP BY u.id ORDER BY u.id DESC`);
  res.json({users:rows});
});
app.get("/api/admin/notes",requireAdmin,async(_req,res)=>{
  const rows=await all(`SELECT n.*,u.name uploader_name,u.email uploader_email FROM notes n JOIN users u ON u.id=n.user_id ORDER BY n.id DESC`);
  res.json({notes:rows});
});
app.delete("/api/admin/notes/:id",requireAdmin,async(req,res)=>{
  const n=await get("SELECT * FROM notes WHERE id=?",[req.params.id]); if(!n)return res.status(404).json({error:"Note not found."});
  await deleteStorage(n.storage_path); await run("DELETE FROM notes WHERE id=?",[n.id]); res.json({ok:true});
});
app.delete("/api/admin/users/:id",requireAdmin,async(req,res)=>{
  const notes=await all("SELECT storage_path FROM notes WHERE user_id=?",[req.params.id]);
  for(const n of notes) await deleteStorage(n.storage_path);
  await run("DELETE FROM users WHERE id=?",[req.params.id]); res.json({ok:true});
});

app.use((err,_req,res,_next)=>{
  console.error(err);
  if(err instanceof multer.MulterError && err.code==="LIMIT_FILE_SIZE") return res.status(400).json({error:`File is too large. Maximum is ${MAX_FILE_SIZE_MB} MB.`});
  res.status(400).json({error:err.message||"Request failed."});
});

app.listen(PORT,()=>{
  console.log(`SLIET Notes Portal: http://localhost:${PORT}`);
  console.log(`Database: ${productionDb ? "PostgreSQL" : "SQLite development fallback"}`);
  console.log(`Storage: ${storageEnabled() ? "Supabase cloud" : "local uploads/"}`);
  if(!transporter)console.log("Development mode: OTPs are shown in the app and terminal; SMTP is optional.");
});
