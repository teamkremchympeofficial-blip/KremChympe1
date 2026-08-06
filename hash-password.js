// Usage: npm run hash-password -- "your-strong-passcode"
// Prints a bcrypt hash to paste into ADMIN_PASSWORD_HASH in your .env file.
// The plaintext password is never stored anywhere once you've done this.

const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "your-strong-passcode"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
console.log('\nAdd this line to your .env file:\n');
console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
