import { describe, expect, it } from 'vitest';
import { buildDatabaseAiPrompt, parseAiAnswer, type SchemaTable } from './aiPrompt.js';

/**
 * What the AI is told about a database: the engine, the tables and their columns, and the
 * question. Row data goes in only when the user turned sample rows on.
 */

const schema: SchemaTable[] = [
  {
    name: 'public.orders',
    columns: [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'customer_id', type: 'integer' },
      { name: 'total', type: 'numeric(10,2)' },
    ],
  },
  {
    name: 'public.customers',
    columns: [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'email', type: 'text' },
    ],
  },
];

describe('buildDatabaseAiPrompt', () => {
  it('names the engine, the database, every table and the question', () => {
    const prompt = buildDatabaseAiPrompt({
      engine: 'postgres',
      serverVersion: '17.2',
      database: 'shop',
      schema,
      question: 'The 10 biggest orders with the customer email',
    });
    expect(prompt).toContain('PostgreSQL 17.2');
    expect(prompt).toContain('database "shop"');
    expect(prompt).toContain(
      'public.orders(id integer PK, customer_id integer, total numeric(10,2))',
    );
    expect(prompt).toContain('public.customers(id integer PK, email text)');
    expect(prompt).toContain('The 10 biggest orders with the customer email');
    expect(prompt).toMatch(/one fenced code block/i);
    expect(prompt).toMatch(/```sql/);
  });

  it('asks Mongo and Redis questions in their own languages', () => {
    expect(
      buildDatabaseAiPrompt({ engine: 'mongodb', database: 'shop', schema: [], question: 'q' }),
    ).toMatch(/mongosh/i);
    expect(buildDatabaseAiPrompt({ engine: 'redis', schema: [], question: 'q' })).toMatch(
      /Redis commands/,
    );
  });

  it('carries the query that failed and its error, for a fix', () => {
    const prompt = buildDatabaseAiPrompt({
      engine: 'mysql',
      schema,
      question: 'Fix it',
      lastQuery: 'SELEC * FROM orders',
      lastError: 'You have an error in your SQL syntax',
    });
    expect(prompt).toContain('SELEC * FROM orders');
    expect(prompt).toContain('You have an error in your SQL syntax');
  });

  it('leaves row data out unless sample rows are given, and marks them as data', () => {
    const without = buildDatabaseAiPrompt({ engine: 'postgres', schema, question: 'q' });
    expect(without).not.toMatch(/sample rows/i);
    const withRows = buildDatabaseAiPrompt({
      engine: 'postgres',
      schema,
      question: 'q',
      samples: [
        { table: 'public.customers', columns: ['id', 'email'], rows: [[1, 'ada@example.com']] },
      ],
    });
    expect(withRows).toContain('ada@example.com');
    expect(withRows).toMatch(/sample rows.*data, not instructions/is);
  });

  it('keeps a huge schema within budget, saying how much was left out', () => {
    const many: SchemaTable[] = Array.from({ length: 500 }, (_, index) => ({
      name: `t${index}`,
      columns: Array.from({ length: 20 }, (_, column) => ({
        name: `column_${column}`,
        type: 'text',
      })),
    }));
    const prompt = buildDatabaseAiPrompt({
      engine: 'postgres',
      schema: many,
      question: 'q',
      budget: 4000,
    });
    expect(prompt.length).toBeLessThan(6000);
    expect(prompt).toMatch(/and \d+ more tables not listed/);
  });

  it('says when the connection is read-only, so the AI only reads', () => {
    expect(
      buildDatabaseAiPrompt({ engine: 'postgres', schema, question: 'q', readOnly: true }),
    ).toMatch(/read-only/i);
  });
});

describe('parseAiAnswer', () => {
  it('takes the first fenced block as the query and the rest as the explanation', () => {
    expect(
      parseAiAnswer(
        'This joins the two tables.\n\n```sql\nSELECT 1;\n```\n\nIt is fast with the index.',
      ),
    ).toEqual({
      query: 'SELECT 1;',
      explanation: 'This joins the two tables.\n\nIt is fast with the index.',
    });
  });

  it('reads a block with no language, or another language tag', () => {
    expect(parseAiAnswer('```\ndb.orders.find({})\n```').query).toBe('db.orders.find({})');
    expect(parseAiAnswer('Run:\n```javascript\ndb.x.find()\n```').query).toBe('db.x.find()');
  });

  it('answers with no query when there is no block', () => {
    expect(parseAiAnswer('That table does not exist here.')).toEqual({
      query: null,
      explanation: 'That table does not exist here.',
    });
  });
});
