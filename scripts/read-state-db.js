// Read CodeArts Agent state databases using sql.js (pure JS)
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const BASE = "C:/Users/xLight/AppData/Roaming/codearts-agent";

async function readDb(SQL, dbPath, label) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`DB: ${label}`);
  console.log("=".repeat(60));

  if (!fs.existsSync(dbPath)) {
    console.log("  File not found");
    return;
  }

  try {
    const buf = fs.readFileSync(dbPath);
    const db = new SQL.Database(buf);

    // List tables
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    if (tables.length > 0) {
      const tableNames = tables[0].values.map((r) => r[0]);
      console.log("Tables:", tableNames.join(", "));

      for (const tname of tableNames) {
        const cols = db.exec(`PRAGMA table_info("${tname}")`);
        const colNames = cols.length > 0 ? cols[0].values.map((r) => r[1]) : [];
        console.log(`\n  Table "${tname}" columns: ${colNames.join(", ")}`);

        const rows = db.exec(`SELECT * FROM "${tname}"`);
        if (rows.length > 0) {
          console.log(`  Rows: ${rows[0].values.length}`);

          for (const row of rows[0].values) {
            const key = String(row[0] || "");
            const value = String(row[1] || "");

            const interesting = [
              "huawei",
              "cloud",
              "dragon",
              "token",
              "session",
              "auth",
              "secret",
              "credential",
              "login",
              "codebot",
              "codearts",
              "CloudDragon",
              "businessToken",
              "accessKey",
              "securityToken",
              "w3",
              "W3",
            ];

            const isInteresting = interesting.some(
              (p) =>
                key.toLowerCase().includes(p.toLowerCase()) ||
                (value.length < 5000 &&
                  value.toLowerCase().includes(p.toLowerCase())),
            );

            if (isInteresting) {
              console.log(`\n  >>> KEY: ${key.substring(0, 300)}`);
              if (value.length > 800) {
                console.log(
                  `  >>> VALUE (${value.length} chars): ${value.substring(0, 800)}...`,
                );
              } else {
                console.log(`  >>> VALUE: ${value}`);
              }
            }
          }
        }
      }
    }

    db.close();
  } catch (e) {
    console.log("  Error:", e.message);
  }
}

async function main() {
  const SQL = await initSqlJs();

  await readDb(
    SQL,
    path.join(BASE, "User/globalStorage/state.vscdb"),
    "Global State",
  );
  await readDb(SQL, path.join(BASE, "SharedStorage"), "Shared Storage");

  const wsDir = path.join(BASE, "User/workspaceStorage");
  if (fs.existsSync(wsDir)) {
    for (const dir of fs.readdirSync(wsDir)) {
      const dbPath = path.join(wsDir, dir, "state.vscdb");
      if (fs.existsSync(dbPath)) {
        await readDb(SQL, dbPath, `Workspace: ${dir}`);
      }
    }
  }
}

main().catch((e) => console.error("Fatal:", e));
