const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.warn('[db] SUPABASE_URL / SUPABASE_ANON_KEY not set — DB disabled');
  module.exports = null;
} else {
  const db = createClient(url, key);
  console.log('[db] Supabase connected:', url);
  module.exports = db;
}
