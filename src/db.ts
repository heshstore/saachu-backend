import { Pool } from "pg";

export const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "saachu_app",
  password: "postgres123",
  port: 5432,
});