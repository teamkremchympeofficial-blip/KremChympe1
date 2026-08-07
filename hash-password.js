// scripts/hash-password.js
//
// Generates the bcrypt hash to put in ADMIN_PASSWORD_HASH (.env).
// Usage: npm run hash-password -- "your-passcode-here"

const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.error('Usage: npm run hash-password -- "your-passcode-here"');
  process.exit(1);
}

bcrypt.hash(password, 10).then((hash) => {
  console.log('\nAdd this to your .env file:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
});
