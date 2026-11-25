<?php
/**
 * A stand-in for WordPress's $wpdb on an in-memory SQLite database, so WpdbStorage can be tested
 * against real tables without MySQL. It keeps the parts of wpdb that matter for SQL injection:
 * prepare() quotes each %s value and casts each %d, like wpdb does, and hands back finished SQL;
 * query() and the get_* methods run whatever SQL they are given. It also records every template
 * prepare() saw and every statement that did not come out of prepare(), so a test can check that
 * no value ever became part of the SQL text.
 *
 * Only the MySQL syntax WpdbStorage uses is translated (INSERT IGNORE, DELETE ... LIMIT, and the
 * column types and keys in Schema::sql()).
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Support;

use Runova\Connector\Schema;

if (!defined('ARRAY_A')) {
    define('ARRAY_A', 'ARRAY_A');
}

final class SqliteWpdb
{
    /** @var string */
    public $base_prefix = 'wp_';

    /** @var int */
    public $insert_id = 0;

    /** @var int */
    public $rows_affected = 0;

    /** @var string */
    public $last_error = '';

    /** @var string[] every template handed to prepare(), as written in the plugin */
    public $templates = array();

    /** @var string[] every statement run, in order */
    public $statements = array();

    /** @var string[] statements run that did not come out of prepare() */
    public $unprepared = array();

    /** @var string[] errors from SQLite; a test expects none */
    public $errors = array();

    /** @var \PDO */
    private $pdo;

    /** @var array<string, bool> SQL that prepare() produced */
    private $prepared = array();

    public function __construct()
    {
        $this->pdo = new \PDO('sqlite::memory:');
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        // mysqli hands every column back as a string, and Rows expects that.
        $this->pdo->setAttribute(\PDO::ATTR_STRINGIFY_FETCHES, true);
        foreach (Schema::sql($this->base_prefix, '') as $create) {
            $this->pdo->exec(self::sqliteTable($create));
        }
    }

    /**
     * Like wpdb::prepare(): %s becomes a quoted, escaped string, %d an integer, %% a percent sign.
     * Values are given one by one or as a single array.
     *
     * @param string $query
     * @param mixed ...$args
     */
    public function prepare($query, ...$args): string
    {
        if (count($args) === 1 && is_array($args[0])) {
            $args = array_values($args[0]);
        }
        $this->templates[] = $query;
        $index = 0;
        $pdo = $this->pdo;
        $sql = preg_replace_callback(
            '/%(.)/',
            function (array $match) use (&$index, $args, $pdo): string {
                $type = $match[1];
                if ($type === '%') {
                    return '%';
                }
                if ($type === 'i') {
                    throw new \LogicException('%i needs WordPress 6.2, and the plugin supports 6.0.');
                }
                if (!in_array($type, array('s', 'd', 'f'), true)) {
                    throw new \LogicException("Unknown placeholder %$type.");
                }
                if (!array_key_exists($index, $args)) {
                    throw new \LogicException('The query has more placeholders than values.');
                }
                $value = $args[$index++];
                if ($type === 'd') {
                    return (string) (int) $value;
                }
                if ($type === 'f') {
                    return (string) (float) $value;
                }
                return $pdo->quote((string) $value);
            },
            (string) $query
        );
        if ($index !== count($args)) {
            throw new \LogicException('The query has more values than placeholders.');
        }
        $this->prepared[(string) $sql] = true;
        return (string) $sql;
    }

    /**
     * @return int|bool rows affected for writes, true for other statements, false on an error
     */
    public function query(string $sql)
    {
        $statement = $this->run($sql);
        if ($statement === null) {
            return false;
        }
        if (preg_match('/^\s*SELECT\b/i', $sql) === 1) {
            return count($statement->fetchAll());
        }
        if (preg_match('/^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i', $sql) === 1) {
            $this->rows_affected = $statement->rowCount();
            return $this->rows_affected;
        }
        return true;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function get_row(string $sql, string $output = 'OBJECT')
    {
        self::arrayOutput($output);
        $statement = $this->run($sql);
        $row = $statement === null ? false : $statement->fetch(\PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    /**
     * @return string|null
     */
    public function get_var(string $sql)
    {
        $statement = $this->run($sql);
        $row = $statement === null ? false : $statement->fetch(\PDO::FETCH_NUM);
        return is_array($row) && $row[0] !== null ? (string) $row[0] : null;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function get_results(string $sql, string $output = 'OBJECT'): array
    {
        self::arrayOutput($output);
        $statement = $this->run($sql);
        return $statement === null ? array() : $statement->fetchAll(\PDO::FETCH_ASSOC);
    }

    /**
     * Like wpdb::insert(): the column names come from the plugin, every value is bound.
     *
     * @param array<string, mixed> $data
     * @return int|false
     */
    public function insert(string $table, array $data)
    {
        foreach (array_keys($data) as $column) {
            if (preg_match('/^[a-z_]+$/', (string) $column) !== 1) {
                throw new \LogicException("Odd column name $column.");
            }
        }
        $sql = "INSERT INTO $table (" . implode(', ', array_keys($data)) . ') VALUES ('
            . implode(', ', array_fill(0, count($data), '?')) . ')';
        $this->statements[] = $sql;
        try {
            $statement = $this->pdo->prepare($sql);
            $statement->execute(array_values($data));
        } catch (\PDOException $error) {
            $this->fail($error, $sql);
            return false;
        }
        $this->insert_id = (int) $this->pdo->lastInsertId();
        return 1;
    }

    public function get_charset_collate(): string
    {
        return '';
    }

    /**
     * The tables that exist, read straight from SQLite.
     *
     * @return string[]
     */
    public function tables(): array
    {
        $names = $this->pdo->query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")->fetchAll(\PDO::FETCH_COLUMN);
        return array_map('strval', $names);
    }

    /**
     * Every row of one of the plugin's tables, read straight from SQLite.
     *
     * @return array<int, array<string, mixed>>
     */
    public function rows(string $name): array
    {
        if (!in_array($name, Schema::TABLES, true)) {
            throw new \LogicException("Not a plugin table: $name.");
        }
        return $this->pdo->query('SELECT * FROM ' . Schema::table($this->base_prefix, $name) . ' ORDER BY rowid')->fetchAll(\PDO::FETCH_ASSOC);
    }

    private function run(string $sql): ?\PDOStatement
    {
        $this->statements[] = $sql;
        if (!isset($this->prepared[$sql])) {
            $this->unprepared[] = $sql;
        }
        try {
            $statement = $this->pdo->query(self::sqliteStatement($sql));
        } catch (\PDOException $error) {
            $this->fail($error, $sql);
            return null;
        }
        return $statement === false ? null : $statement;
    }

    private function fail(\PDOException $error, string $sql): void
    {
        $this->last_error = $error->getMessage();
        $this->errors[] = $error->getMessage() . ' in: ' . $sql;
    }

    private static function arrayOutput(string $output): void
    {
        if ($output !== ARRAY_A) {
            throw new \LogicException('WpdbStorage reads rows as ARRAY_A.');
        }
    }

    /** The MySQL statements WpdbStorage writes, in SQLite's words. */
    private static function sqliteStatement(string $sql): string
    {
        $sql = (string) preg_replace('/^\s*INSERT IGNORE INTO\b/i', 'INSERT OR IGNORE INTO', $sql);
        if (preg_match('/^\s*DELETE\b/i', $sql) === 1) {
            $sql = (string) preg_replace('/\s+LIMIT\s+\d+\s*$/i', '', $sql);
        }
        return $sql;
    }

    /** One CREATE TABLE from Schema::sql(), without the MySQL-only parts. */
    private static function sqliteTable(string $create): string
    {
        $create = str_replace('bigint(20) unsigned NOT NULL AUTO_INCREMENT', 'INTEGER NOT NULL', $create);
        $create = str_replace(' unsigned', '', $create);
        $create = (string) preg_replace('/^KEY .*$\n?/m', '', $create);
        return (string) preg_replace('/,\s*\n\)/', "\n)", $create);
    }
}
