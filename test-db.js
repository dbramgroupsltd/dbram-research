const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:Sikamorevictor74%40yahoo.com@[2a05:d018:175d:b602:c88b:b661:f30c:7a11]:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function test() {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Connected to Supabase!');
    console.log('Time:', result.rows[0].now);
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
  }
}

test();