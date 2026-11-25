<?php
/**
 * WpdbStorage keeps every value out of the SQL text. Hostile ids, keys, labels and addresses go
 * through each storage method against real tables (SQLite standing in for MySQL, see
 * SqliteWpdb). Each test checks that the text was stored and read back as it was sent, that it
 * only matched the rows it literally names, that the decoy rows and every table are untouched,
 * and that no template handed to $wpdb->prepare() (or any SQL run without it) holds the input.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Schema;
use Runova\Connector\Storage\WpdbStorage;
use Runova\Connector\Tests\Support\SqliteWpdb;
use Runova\Connector\Tests\Support\TestCase;

final class SqlInjectionTest extends TestCase
{
    /** Text that would change the statement if it ever became part of the SQL. */
    const HOSTILE = array(
        "'; DROP TABLE wp_runova_kv; --",
        "' OR '1'='1",
        "\\' OR 1=1 -- ",
        'x" OR "1"="1',
        "%s' OR 'a'='a' -- %d",
        '1) OR (1=1',
        "'' OR id LIKE '%",
    );

    const FAR = 4000000000;

    /** Hostile text that names no row at all. */
    const MISSING = array(
        "nobody' OR '1'='1",
        "nobody' OR 1=1 -- ",
        "nobody\\' OR 1=1 -- ",
        'nobody%',
        '_',
    );

    /** @var SqliteWpdb */
    private $db;

    /** @var WpdbStorage */
    private $sql;

    /** @var array<string, array<int, array<string, mixed>>> the decoy rows as they were stored */
    private $decoys = array();

    protected function setUp(): void
    {
        parent::setUp();
        $this->db = new SqliteWpdb();
        $this->sql = new WpdbStorage($this->db);
        $this->sql->insertConnection(self::connectionRow('decoy'));
        $this->sql->insertPairing(self::pairingRow('decoy'));
        // Far-off times, so the purge a real request runs leaves the decoys alone.
        $this->sql->insertNonce('decoy', self::FAR);
        $this->sql->addAudit(array('at' => 1, 'event' => 'decoy', 'ip' => '192.0.2.1', 'detail' => 'decoy', 'noise' => 0));
        $this->sql->kvSet('decoy', 'keep', null);
        $this->sql->insertDeploy(self::deployRow('decoy'));
        $this->sql->putHash('decoy', 1, 2, 'decoy-sha', self::FAR);
        foreach (Schema::TABLES as $table) {
            $this->decoys[$table] = $this->db->rows($table);
        }
        $this->db->templates = array();
        $this->db->unprepared = array();
    }

    public function testConnectionIdsLabelsAndAddressesAreData(): void
    {
        foreach (self::HOSTILE as $text) {
            $this->sql->insertConnection(self::connectionRow($text, array('label' => $text, 'device_name' => $text)));
        }
        foreach (self::HOSTILE as $text) {
            $row = $this->sql->getConnection($text);
            $this->assertNotNull($row, $text);
            $this->assertSame($text, $row['id']);
            $this->assertSame($text, $row['label']);
            $this->assertSame($text, $row['device_name']);
            $this->sql->touchConnection($text, 2000, $text);
            $this->sql->revokeConnection($text, 3000);
            $row = $this->sql->getConnection($text);
            $this->assertSame($text, $row['last_ip']);
            $this->assertSame(2000, $row['last_seen_at']);
            $this->assertSame(3000, $row['revoked_at']);
        }
        foreach (self::MISSING as $text) {
            $this->assertNull($this->sql->getConnection($text), $text);
            $this->sql->touchConnection($text, 4000, $text);
            $this->sql->revokeConnection($text, 4000);
        }
        $ids = array_column($this->sql->listConnections(), 'id');
        sort($ids);
        $expected = array_merge(array('decoy'), self::HOSTILE);
        sort($expected);
        $this->assertSame($expected, $ids);
        // Each hostile row was changed by its own statements only.
        foreach (self::HOSTILE as $text) {
            $this->assertSame(3000, $this->sql->getConnection($text)['revoked_at']);
        }
        $this->assertTreatedAsData();
    }

    public function testPairingIdsAreData(): void
    {
        foreach (self::HOSTILE as $text) {
            $this->sql->insertPairing(self::pairingRow($text, array('label' => $text)));
        }
        foreach (self::HOSTILE as $text) {
            $this->assertSame($text, $this->sql->getPairing($text)['label']);
            $this->assertSame(1, $this->sql->addPairingAttempt($text), $text);
            $this->assertTrue($this->sql->usePairing($text, 50), $text);
            $this->assertFalse($this->sql->usePairing($text, 60), $text);
            $row = $this->sql->getPairing($text);
            $this->assertSame(50, $row['used_at']);
            $this->assertNull($row['secret']);
        }
        foreach (self::MISSING as $text) {
            $this->assertNull($this->sql->getPairing($text), $text);
            $this->assertSame(0, $this->sql->addPairingAttempt($text), $text);
            $this->assertFalse($this->sql->usePairing($text, 70), $text);
            $this->sql->burnPairing($text);
        }
        foreach (self::HOSTILE as $text) {
            $this->assertSame(1, $this->sql->getPairing($text)['attempts']);
            $this->assertFalse($this->sql->getPairing($text)['burned']);
        }
        $this->assertTreatedAsData();
    }

    public function testNonceHashesAreData(): void
    {
        foreach (self::HOSTILE as $text) {
            $this->assertTrue($this->sql->insertNonce($text, 9000), $text);
            $this->assertFalse($this->sql->insertNonce($text, 9000), $text);
        }
        $this->assertSame(
            array_merge(array('decoy'), self::HOSTILE),
            array_column($this->db->rows('nonces'), 'nonce_hash')
        );
        $this->assertTreatedAsData();
    }

    public function testKeysAndValuesAreData(): void
    {
        foreach (self::HOSTILE as $text) {
            $this->sql->kvSet($text, $text, null);
            $this->assertSame($text, $this->sql->kvGet($text, 100), $text);
            $this->assertFalse($this->sql->kvAdd($text, 'other', null, 100), $text);
            $this->assertSame($text, $this->sql->kvGet($text, 100));
            $this->sql->kvSet($text, $text . '2', 5000);
            $this->assertSame($text . '2', $this->sql->kvGet($text, 100));
        }
        foreach (self::MISSING as $text) {
            $this->assertNull($this->sql->kvGet($text, 100), $text);
            $this->assertTrue($this->sql->kvAdd($text, $text, 9000, 100), $text);
            $this->assertSame($text, $this->sql->kvGet($text, 100));
            $this->sql->kvDelete($text);
            $this->assertNull($this->sql->kvGet($text, 100));
        }
        // Deleting one key leaves every other key alone.
        $this->sql->kvDelete(self::HOSTILE[0]);
        $this->assertNull($this->sql->kvGet(self::HOSTILE[0], 100));
        foreach (array_slice(self::HOSTILE, 1) as $text) {
            $this->assertSame($text . '2', $this->sql->kvGet($text, 100), $text);
        }
        $this->assertTreatedAsData();
    }

    public function testAuditTextIsData(): void
    {
        foreach (self::HOSTILE as $text) {
            $id = $this->sql->addAudit(array(
                'at' => 10,
                'event' => $text,
                'connection_id' => $text,
                'connection_label' => $text,
                'ip' => $text,
                'detail' => $text,
                'noise' => 0,
            ));
            $this->assertGreaterThan(1, $id);
        }
        $rows = array_reverse($this->sql->listAudit(50, null));
        $this->assertCount(count(self::HOSTILE) + 1, $rows);
        foreach (self::HOSTILE as $index => $text) {
            $row = $rows[$index + 1];
            foreach (array('event', 'connection_id', 'connection_label', 'ip', 'detail') as $column) {
                $this->assertSame($text, $row[$column], $column);
            }
        }
        $this->assertTreatedAsData();
    }

    public function testDeployIdsStatesAndFieldsAreData(): void
    {
        foreach (self::HOSTILE as $text) {
            $this->sql->insertDeploy(self::deployRow($text, array('connection_id' => $text, 'label' => $text, 'data' => json_encode(array('note' => $text)))));
        }
        foreach (self::HOSTILE as $text) {
            $row = $this->sql->getDeploy($text);
            $this->assertSame($text, $row['label']);
            $this->assertSame(array('note' => $text), json_decode($row['data'], true));
            // A hostile expected state matches no row, not every row.
            $this->assertFalse($this->sql->updateDeploy($text, array('label' => 'changed'), "open' OR '1'='1"), $text);
            $this->assertSame($text, $this->sql->getDeploy($text)['label']);
            $this->assertTrue($this->sql->updateDeploy($text, array('state' => $text, 'label' => $text . '!', 'puts' => 3, 'reason' => null), 'open'), $text);
            $row = $this->sql->getDeploy($text);
            $this->assertSame($text, $row['state']);
            $this->assertSame($text . '!', $row['label']);
            $this->assertSame(3, $row['puts']);
            // The state it now has, hostile as it is, is matched literally.
            $this->assertTrue($this->sql->updateDeploy($text, array('puts' => 4), $text), $text);
        }
        foreach (self::MISSING as $text) {
            $this->assertNull($this->sql->getDeploy($text), $text);
            $this->assertFalse($this->sql->updateDeploy($text, array('label' => 'changed')), $text);
            $this->sql->deleteDeploy($text);
        }
        $this->assertCount(count(self::HOSTILE) + 1, $this->sql->listDeploys(100));
        $this->sql->deleteDeploy(self::HOSTILE[1]);
        $this->assertNull($this->sql->getDeploy(self::HOSTILE[1]));
        $this->assertCount(count(self::HOSTILE), $this->sql->listDeploys(100));
        $this->assertTreatedAsData();
    }

    public function testDeployColumnNamesComeOnlyFromTheAllowList(): void
    {
        $names = array(
            "label` = 'x', `state",
            "state = 'x' WHERE 1=1 -- ",
            'label`',
            'id',
            'rev',
            'started_at',
        );
        $before = count($this->db->statements);
        foreach ($names as $name) {
            try {
                $this->sql->updateDeploy('decoy', array($name => 'x'));
                $this->fail("Column $name was accepted.");
            } catch (\InvalidArgumentException $error) {
                $this->assertSame('Unknown deploy column.', $error->getMessage());
            }
        }
        $this->assertSame($before, count($this->db->statements), 'Nothing reached the database.');
        $this->assertTreatedAsData();
    }

    public function testHashCacheKeysAreData(): void
    {
        foreach (self::HOSTILE as $text) {
            $this->sql->putHash($text, 10, 20, $text, 1000);
        }
        $files = array();
        foreach (array_merge(self::HOSTILE, self::MISSING) as $text) {
            $files[$text] = array('size' => 10, 'mtime' => 20);
        }
        $expected = array();
        foreach (self::HOSTILE as $text) {
            $expected[$text] = $text;
        }
        $found = $this->sql->getHashes($files);
        ksort($expected);
        ksort($found);
        $this->assertSame($expected, $found);
        $this->assertTreatedAsData();
    }

    public function testRequestsRunOnTheTablesWithHostileLabelsAndAddresses(): void
    {
        $this->makeSite();
        $this->storage = new WpdbStorage($this->db);
        $label = self::HOSTILE[1];
        $connection = $this->connect('read', array('label' => $label, 'device_name' => self::HOSTILE[0]));
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $connection)));
        // A connection id that is not one never gets as far as the database.
        $this->assertError('unknownConnection', $this->call('/site/info', null, array('connectionId' => '00000000-0000-4000-8000-000000000000')));
        // ClientIp only lets real addresses through; past it, a hostile one is still audited and
        // counted as plain text.
        $ip = self::HOSTILE[0];
        $other = Crypto::keypairFromSeed(str_repeat("\x07", 32));
        $this->assertError('badSignature', $this->call('/site/info', null, array('connectionId' => $connection, 'ip' => $ip, 'secretKey' => $other['secret'])), 401);
        $this->assertContains($ip, array_column($this->db->rows('audit'), 'ip'));
        $this->assertSame($label, $this->storage->getConnection($connection)['label']);
        $this->assertTreatedAsData();
    }

    /**
     * No SQL error, every table still there, the decoy rows as they were, and no hostile text in
     * the SQL the plugin wrote.
     */
    private function assertTreatedAsData(): void
    {
        $this->assertSame(array(), $this->db->errors);
        $tables = array_map(function (string $name): string {
            return Schema::table($this->db->base_prefix, $name);
        }, Schema::TABLES);
        sort($tables);
        $this->assertSame($tables, array_values(array_filter($this->db->tables(), function (string $name): bool {
            return strpos($name, 'sqlite_') !== 0;
        })));
        foreach ($this->decoys as $table => $rows) {
            $now = $this->db->rows($table);
            $this->assertSame($rows[0], $now[0], "The decoy row in $table changed.");
        }
        foreach (array_merge($this->db->templates, $this->db->unprepared) as $sql) {
            foreach (array_merge(self::HOSTILE, self::MISSING) as $text) {
                if (strlen($text) > 2) {
                    $this->assertFalse(strpos($sql, $text), "Input became SQL text: $sql");
                }
            }
        }
        // The only SQL run without prepare() is the constant list of connections.
        foreach (array_unique($this->db->unprepared) as $sql) {
            $this->assertSame('SELECT * FROM wp_runova_connections ORDER BY created_at DESC LIMIT 500', $sql);
        }
    }

    /**
     * @param array<string, mixed> $extra
     * @return array<string, mixed>
     */
    private static function connectionRow(string $id, array $extra = array()): array
    {
        return array_merge(array(
            'id' => $id,
            'label' => 'Decoy',
            'scope' => 'read',
            'public_key' => str_repeat('A', 43),
            'device_name' => 'Decoy',
            'created_at' => 1000,
            'expires_at' => null,
            'revoked_at' => null,
            'last_seen_at' => null,
            'last_ip' => '',
            'created_by' => 1,
        ), $extra);
    }

    /**
     * @param array<string, mixed> $extra
     * @return array<string, mixed>
     */
    private static function pairingRow(string $id, array $extra = array()): array
    {
        return array_merge(array(
            'id' => $id,
            'secret' => 'secret-of-' . md5($id),
            'scope' => 'read',
            'label' => 'Decoy',
            'connection_ttl' => null,
            'created_at' => 1000,
            'expires_at' => self::FAR,
            'attempts' => 0,
            'burned' => false,
            'used_at' => null,
            'created_by' => 1,
        ), $extra);
    }

    /**
     * @param array<string, mixed> $extra
     * @return array<string, mixed>
     */
    private static function deployRow(string $id, array $extra = array()): array
    {
        return array_merge(array(
            'id' => $id,
            'connection_id' => 'decoy',
            'connection_label' => 'Decoy',
            'label' => 'Decoy',
            'state' => 'open',
            'reason' => null,
            'started_at' => 1000,
            'updated_at' => 1000,
            'finished_at' => null,
            'deadline' => 2000,
            'puts' => 0,
            'deletes' => 0,
            'data' => '{}',
        ), $extra);
    }
}
