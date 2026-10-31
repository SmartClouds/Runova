import type { DbEngine } from '@runova/core';
import {
  siApachecassandra,
  siMariadb,
  siMongodb,
  siMysql,
  siPostgresql,
  siRedis,
  siSqlite,
} from 'simple-icons';
import { cn } from '@/lib/utils';

/**
 * Each engine's logo in a soft tile of its own colour, so a card is recognisable at a glance.
 * SQL Server has no mark in simple-icons, so it gets a lettered tile.
 */

const MARKS: Partial<Record<DbEngine, { path: string; hex: string }>> = {
  postgres: siPostgresql,
  mysql: siMysql,
  mariadb: siMariadb,
  mongodb: siMongodb,
  redis: siRedis,
  sqlite: siSqlite,
  cassandra: siApachecassandra,
};

export function EngineMark({
  engine,
  size = 'md',
  className,
}: {
  engine: DbEngine;
  size?: 'sm' | 'md';
  className?: string;
}): React.JSX.Element {
  const mark = MARKS[engine];
  const box = size === 'sm' ? 'h-6 w-6 rounded-md' : 'h-10 w-10 rounded-xl';
  const glyph = size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5';
  const color = mark ? `#${mark.hex}` : '#CC2927';
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center', box, className)}
      style={{ backgroundColor: `${color}1f`, color }}
    >
      {mark ? (
        <svg viewBox="0 0 24 24" className={cn(glyph, 'fill-current dark:brightness-150')}>
          <path d={mark.path} />
        </svg>
      ) : (
        <span
          className={cn('font-bold leading-none', size === 'sm' ? 'text-[8px]' : 'text-[10px]')}
        >
          SQL
        </span>
      )}
    </span>
  );
}
