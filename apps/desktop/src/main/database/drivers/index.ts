import { openMongo } from './mongodb';
import { openMysql } from './mysql';
import { openPostgres } from './postgres';
import { openRedis } from './redis';
import { openSqlite } from './sqlite';
import { type DbDriver, type DriverConnectOptions, DriverError } from './types';

/** Signs in to a database with the adapter for its engine. */
export async function openDriver(options: DriverConnectOptions): Promise<DbDriver> {
  switch (options.engine) {
    case 'postgres':
      return openPostgres(options);
    case 'mysql':
    case 'mariadb':
      return openMysql(options);
    case 'mongodb':
      return openMongo(options);
    case 'redis':
      return openRedis(options);
    case 'sqlite':
      return openSqlite(options);
    default:
      throw new DriverError(`Connecting to ${options.engine} is not supported yet.`);
  }
}

export type OpenDriver = typeof openDriver;
