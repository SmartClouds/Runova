import { describe, expect, it } from 'vitest';
import { buildFileSymbols, languageOf } from './symbolExtractors';

/**
 * What `t:` and `m:` find in each language. These are line patterns, not a parser, so each
 * table also carries the everyday lines that look like a declaration and must not become one.
 */

function symbols(path: string, source: string): string[] {
  const lang = languageOf(path);
  if (!lang) throw new Error(`no language for ${path}`);
  const lines = source.split('\n').map((text, at) => ({ line: at + 1, text }));
  return buildFileSymbols(lang, path, lines).map(
    (entry) => `${entry.kind} ${entry.container ? `${entry.container}.` : ''}${entry.name}`,
  );
}

describe('languageOf', () => {
  it('knows the languages by extension, in any case', () => {
    expect(languageOf('src/a.tsx')).toBe('ts');
    expect(languageOf('A.CS')).toBe('csharp');
    expect(languageOf('lib/x.hpp')).toBe('cpp');
    expect(languageOf('README.md')).toBeNull();
  });
});

describe('TypeScript and JavaScript', () => {
  const source = `import { x } from './x';
export type { Foo } from './foo';
export interface User {
  id: string;
  name?: string;
  greet(): void;
}
export type Id = string | number;
export enum Color { Red }
export const MAX_USERS = 10;
export const loadUsers = async (id: string) => {
  const local = 1;
  if (local) {
    return fetch(id);
  }
};
export function formatUser(user: User): string {
  return user.name;
}
// class NotReal {}
/** function alsoNotReal() */
export abstract class UserStore<T> extends Base {
  private readonly cache = new Map<string, User>();
  #count = 0;
  static instance: UserStore<unknown>;
  constructor(private api: Api) {
    super();
  }
  async load(id: string): Promise<User> {
    for (const x of y) {
      doThing(x);
    }
    return this.cache.get(id);
  }
  get size(): number {
    return this.cache.size;
  }
  abstract save(user: User): void;
  handle = async (event: Event) => {
    console.log(event);
  };
}
namespace Legacy {
  export function old() {}
}`;

  it('finds the declarations and nothing else', () => {
    expect(symbols('src/user.ts', source)).toEqual([
      'interface User',
      'property User.id',
      'property User.name',
      'method User.greet',
      'type Id',
      'enum Color',
      'const MAX_USERS',
      'function loadUsers',
      'function formatUser',
      'class UserStore',
      'property UserStore.cache',
      'property UserStore.#count',
      'property UserStore.instance',
      'constructor UserStore.constructor',
      'method UserStore.load',
      'property UserStore.size',
      'method UserStore.save',
      'method UserStore.handle',
      'namespace Legacy',
      'function old',
    ]);
  });

  it('says where the name starts', () => {
    const lang = languageOf('a.ts');
    const [entry] = buildFileSymbols(lang ?? 'ts', 'a.ts', [
      { line: 7, text: '  export class Widget {' },
    ]);
    expect(entry).toMatchObject({ name: 'Widget', line: 7, column: 16, path: 'a.ts' });
  });
});

describe('Python', () => {
  it('finds classes, methods and constants', () => {
    const source = `import os
MAX_SIZE = 10
# class Commented:
class Repo(Base):
    VERSION = 2
    def __init__(self, path):
        self.path = path
    async def fetch(self):
        def helper():
            pass
        return helper
def main():
    pass`;
    expect(symbols('repo.py', source)).toEqual([
      'const MAX_SIZE',
      'class Repo',
      'constructor Repo.__init__',
      'method Repo.fetch',
      'function fetch.helper',
      'function main',
    ]);
  });
});

describe('Go', () => {
  it('finds types, functions and methods on their receiver', () => {
    const source = `package store
type User struct {
	ID string
}
type Reader interface {
	Read() error
}
type ID = string
func (s *Store) Load(id string) (*User, error) {
	return nil, nil
}
func NewStore() *Store {
	return &Store{}
}
const MaxUsers = 10`;
    expect(symbols('store.go', source)).toEqual([
      'struct User',
      'interface Reader',
      'method Reader.Read',
      'type ID',
      'method Store.Load',
      'function NewStore',
      'const MaxUsers',
    ]);
  });
});

describe('Rust', () => {
  it('finds items and puts impl methods under their type', () => {
    const source = `pub struct Config {
    pub name: String,
}
pub enum Mode { A, B }
pub trait Store {
    fn load(&self) -> Config;
}
impl Store for Disk {
    fn load(&self) -> Config {
        todo!()
    }
}
impl Config {
    pub const DEFAULT: u8 = 1;
    pub fn new() -> Self {
        Self { name: String::new() }
    }
}
pub(crate) async fn run() {}
mod tests {
    fn helper() {}
}
type Result<T> = std::result::Result<T, Error>;`;
    expect(symbols('lib.rs', source)).toEqual([
      'struct Config',
      'enum Mode',
      'trait Store',
      'method Store.load',
      'method Disk.load',
      'const Config.DEFAULT',
      'method Config.new',
      'function run',
      'namespace tests',
      'function helper',
      'type Result',
    ]);
  });
});

describe('C#', () => {
  it('finds types, members and constructors', () => {
    const source = `namespace Academy.Settings;
public struct SystemSetting
{
    public const string CompanyName = "S.S";
    public const int DefaultPageSize = 20;
}
public sealed class UserService : IUserService
{
    private readonly IRepo _repo;
    private readonly Dictionary<string, int> _counts = new();
    public UserService(IRepo repo)
    {
        _repo = repo;
    }
    public string Name { get; set; }
    public async Task<User> GetAsync(int id)
    {
        var user = await _repo.Find(id);
        return Map(user);
    }
    private static User Map(Entity e) => new User(e);
}
public interface IUserService
{
    Task<User> GetAsync(int id);
}
public record Person(string Name);
public enum Status { Active }`;
    expect(symbols('UserService.cs', source)).toEqual([
      'namespace Academy.Settings',
      'struct SystemSetting',
      'const SystemSetting.CompanyName',
      'const SystemSetting.DefaultPageSize',
      'class UserService',
      'field UserService._repo',
      'field UserService._counts',
      'constructor UserService.UserService',
      'property UserService.Name',
      'method UserService.GetAsync',
      'method UserService.Map',
      'interface IUserService',
      'method IUserService.GetAsync',
      'record Person',
      'enum Status',
    ]);
  });

  it('finds the shapes a test project and a modern solution are full of', () => {
    const source = `namespace Runova.ServerCore.Tests;
[Collection("Docker")] public sealed class SecretsTests : IAsyncLifetime
{
    [Fact] public async Task PreRenameSecrets()
    {
        await Task.Delay(1);
    }
    [Theory, InlineData(1)] public void KeepsOld(int value) { }
    public (int Count, string Name) Totals() => (0, "");
    public T Find<T>(int id) where T : class
    {
        return default!;
    }
    public event EventHandler? Changed;
    public delegate void Renamed(string from, string to);
    [JsonPropertyName("id")] public string Id { get; init; } = "";
}
public readonly record struct Point(int X, int Y);
file sealed class Hidden { }`;
    expect(symbols('SecretsTests.cs', source)).toEqual([
      'namespace Runova.ServerCore.Tests',
      'class SecretsTests',
      'method SecretsTests.PreRenameSecrets',
      'method SecretsTests.KeepsOld',
      'method SecretsTests.Totals',
      'method SecretsTests.Find',
      'field SecretsTests.Changed',
      'type SecretsTests.Renamed',
      'property SecretsTests.Id',
      'record Point',
      'class Hidden',
    ]);
  });
});

describe('Java', () => {
  it('finds classes, fields, constructors and methods', () => {
    const source = `package com.example;
public class OrderService implements Service {
    private static final int LIMIT = 5;
    private final Repo repo;
    public OrderService(Repo repo) {
        this.repo = repo;
    }
    @Override
    public List<Order> findAll(String customer) throws IOException {
        return repo.find(customer);
    }
    void reset() {
    }
}
interface Service {
    List<Order> findAll(String customer) throws IOException;
}
enum Kind { A, B }
public record Point(int x, int y) {}`;
    expect(symbols('OrderService.java', source)).toEqual([
      'class OrderService',
      'const OrderService.LIMIT',
      'field OrderService.repo',
      'constructor OrderService.OrderService',
      'method OrderService.findAll',
      'method OrderService.reset',
      'interface Service',
      'method Service.findAll',
      'enum Kind',
      'record Point',
    ]);
  });
});

describe('Kotlin', () => {
  it('finds classes, objects, functions and properties', () => {
    const source = `data class User(val id: String)
interface Repo {
    fun find(id: String): User?
}
object Registry {
    val users = mutableListOf<User>()
    fun register(user: User) {
        val local = user
    }
}
enum class Level { LOW }
fun main() {}
typealias Users = List<User>`;
    expect(symbols('Main.kt', source)).toEqual([
      'class User',
      'interface Repo',
      'method Repo.find',
      'class Registry',
      'property Registry.users',
      'method Registry.register',
      'enum Level',
      'function main',
      'type Users',
    ]);
  });
});

describe('Swift', () => {
  it('finds types, extensions, initializers and properties', () => {
    const source = `protocol Store {
    func load() -> Int
}
final class DiskStore: Store {
    private var cache: [Int] = []
    init(path: String) {}
    func load() -> Int { 0 }
}
struct Point { let x: Int }
enum Mode { case a }
extension DiskStore {
    static func make() -> DiskStore {}
}`;
    expect(symbols('Store.swift', source)).toEqual([
      'interface Store',
      'method Store.load',
      'class DiskStore',
      'property DiskStore.cache',
      'constructor DiskStore.init',
      'method DiskStore.load',
      'struct Point',
      'enum Mode',
      'method DiskStore.make',
    ]);
  });
});

describe('PHP', () => {
  it('finds classes, methods, constants and properties', () => {
    const source = `<?php
namespace App\\Models;
final class Invoice extends Model
{
    public const STATUS_PAID = 'paid';
    protected ?string $number = null;
    public function total(): float
    {
    }
    private static function round($v) {}
}
interface Payable {}
trait Loggable {}
function helper() {}`;
    expect(symbols('Invoice.php', source)).toEqual([
      'namespace App\\Models',
      'class Invoice',
      'const Invoice.STATUS_PAID',
      'property Invoice.number',
      'method Invoice.total',
      'method Invoice.round',
      'interface Payable',
      'trait Loggable',
      'function helper',
    ]);
  });
});

describe('C and C++', () => {
  it('finds types and functions, declarations and definitions alike', () => {
    const source = `#include <vector>
namespace app {
class Widget : public Base {
public:
    Widget(int size);
    void draw() const;
    int size() const { return size_; }
private:
    int size_;
};
struct Point { int x; };
struct Forward;
typedef unsigned long ulong;
enum class Color { Red };
Widget::Widget(int size) : size_(size) {}
void Widget::draw() const {
    if (size_ > 0) {
        render(size_);
    }
}
static int helper(int a, int b)
{
    return a + b;
}
}`;
    expect(symbols('widget.cpp', source)).toEqual([
      'namespace app',
      'class Widget',
      'constructor Widget.Widget',
      'method Widget.draw',
      'method Widget.size',
      'struct Point',
      'type ulong',
      'enum Color',
      'constructor Widget.Widget',
      'method Widget.draw',
      'function helper',
    ]);
  });
});
