import { runSqlFile } from "../server/db";

await runSqlFile("init.sql");
console.log("Database schema initialized.");
