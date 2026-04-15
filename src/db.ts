import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

export const dbConfig: TypeOrmModuleOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USERNAME || 'postgres',
  password: String(process.env.DB_PASSWORD), // 🔥 IMPORTANT FIX
  database: process.env.DB_NAME || 'saachu',
  autoLoadEntities: true,
  synchronize: false,
};