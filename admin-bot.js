// lib/admin-bot.js
//
// Lets the super admin manage tours' Telegram Chat IDs by texting the bot
// directly, instead of logging into the web dashboard. Replaces
// dashboard.html / the /api/admin/* routes as the day-to-day way to do
// this — those still work if you want to keep them as a backup.
//
// Only chat IDs listed in SUPER_ADMIN_CHAT_IDS (comma-separated in the
// env) can use these commands. Messages from anyone else are ignored
// silently — the bot never reveals that admin commands exist to a
// stranger who messages it.

const store = require('./store');

const CHAT_ID_PATTERN = /^-?\d{5,15}$/;

// Every static label/heading/button/note on the booking page that's
// tagged with a matching data-ckey="..." attribute in index.html. This
// is the reference list /text shows, and /settext validates against —
// keep it in sync if you add a new data-ckey to the page.
const TEXT_KEYS = [
  { key: 'heading.main', label: 'Page heading', defaultValue: 'Book Adventure With US' },
  { key: 'label.requirednote', label: '"required field" note', defaultValue: '* Indicates required question' },
  { key: 'label.fullname', label: 'Full name field label', defaultValue: 'Full Name' },
  { key: 'label.phone', label: 'Phone field label', defaultValue: 'Phone Number' },
  { key: 'label.email', label: 'Email field label', defaultValue: 'Email' },
  { key: 'label.tourdate', label: 'Tour date field label', defaultValue: 'Tour date' },
  { key: 'label.datefield', label: 'Date sub-label', defaultValue: 'Date' },
  { key: 'label.people', label: 'People count field label', defaultValue: 'Number Of Adult & childern' },
  { key: 'label.paymentmethod', label: 'Payment method field label', defaultValue: 'Payment Method' },
  { key: 'payment.upi', label: '"UPI" payment option', defaultValue: 'UPI' },
  { key: 'payment.bank', label: '"Bank Transfer" payment option', defaultValue: 'Bank Transfer' },
  { key: 'payment.qr', label: '"QR Code" payment option', defaultValue: 'QR Code' },
  { key: 'text.requiredfield', label: 'Required-field error message', defaultValue: 'This is a required question' },
  { key: 'button.next', label: '"Next" button', defaultValue: 'Next' },
  { key: 'button.back', label: '"Back" button', defaultValue: 'Back' },
  { key: 'button.submit', label: '"Submit" button', defaultValue: 'Submit' },
  { key: 'button.clearform', label: '"Clear form" button', defaultValue: 'Clear form' },
  { key: 'button.copy', label: '"Copy" button (UPI ID / account no / IFSC)', defaultValue: 'Copy' },
  { key: 'button.replace', label: '"Replace" receipt button', defaultValue: 'Replace' },
  { key: 'button.remove', label: '"Remove" receipt button', defaultValue: 'Remove' },
  { key: 'upi.header', label: 'UPI page header', defaultValue: 'Payment By UPI' },
  { key: 'upi.appnote', label: 'UPI app note', defaultValue: 'Opens Google Pay, PhonePe, Paytm or any UPI app on your phone' },
  { key: 'upi.idlabel', label: '"UPI ID" label', defaultValue: 'UPI ID' },
  { key: 'bank.header', label: 'Bank page header', defaultValue: 'Bank Detail' },
  { key: 'bank.acnolabel', label: '"A/C No" label', defaultValue: 'A/C No' },
  { key: 'bank.ifsclabel', label: '"IFSC Code" label', defaultValue: 'IFSC Code' },
  { key: 'qr.header', label: 'QR page header', defaultValue: 'Scan QR Code' },
  { key: 'qr.scanlabel', label: '"SCAN AND PAY" label', defaultValue: 'SCAN AND PAY' },
  { key: 'qr.appnote', label: 'QR app note', defaultValue: 'Save the image, then scan it with any UPI app to pay' },
  { key: 'confirm.headline.waiting', label: 'Confirmation page headline (initial)', defaultValue: 'Waiting for Confirmation' },
  { key: 'confirm.headline.confirmed', label: 'Confirmation page headline (once guide confirms)', defaultValue: 'Booking Confirmed' },
  { key: 'confirm.headline.cancelled', label: 'Confirmation page headline (once guide cancels)', defaultValue: 'Booking Cancelled' },
  { key: 'confirm.status.waiting', label: 'Waiting status banner text', defaultValue: 'Waiting Confirmation — this page updates automatically once our guide confirms.' },
  { key: 'confirm.status.confirmed', label: 'Confirmed status banner text', defaultValue: 'Booking Confirmed ✅ — see you on your tour date!' },
  { key: 'confirm.status.cancelled', label: 'Cancelled status banner text', defaultValue: 'Booking Cancelled ❌ — please contact the tour guide for details.' },
  { key: 'confirm.label.bookingid', label: '"Booking ID" label', defaultValue: 'Booking ID' },
  { key: 'confirm.label.submitted', label: '"Submitted" label', defaultValue: 'Submitted' },
  { key: 'confirm.label.tourdate', label: '"Tour Date" label', defaultValue: 'Tour Date' },
  { key: 'confirm.label.paymentmethod', label: '"Payment Method" label', defaultValue: 'Payment Method' },
  { key: 'confirm.label.paidnow', label: '"Amount Paid Now" label', defaultValue: 'Amount Paid Now' },
  { key: 'confirm.label.balance', label: '"Balance Due on Arrival" label', defaultValue: 'Balance Due on Arrival' },
  { key: 'confirm.label.total', label: '"Total Amount" label', defaultValue: 'Total Amount' },
  { key: 'confirm.note', label: 'Note below booking summary', defaultValue: "We've sent your booking details and payment receipt to our tour guide." },
];

function getAdminChatIds() {
  return String(process.env.SUPER_ADMIN_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAdmin(chatId) {
  return getAdminChatIds().includes(String(chatId));
}

const HELP_TEXT =
`Super admin commands:

TOURS
/tours
  List every tour with its id and current Chat ID.
/setchatid <tourId> <chatId>
  Set (or change) the guide's Chat ID for a tour.
  e.g. /setchatid krem-chympe -100123456789
/removechatid <tourId>
  Remove the Chat ID (pauses notifications for that tour).
/addtour <name> | <chatId>
  Add a new tour. The chat id is optional.
  e.g. /addtour Krem Mawmluh Cave Tour | -100987654321
/deletetour <tourId>
  Delete a tour entirely. Cannot be undone.

WEBSITE TEXT
/text
  List every editable label/heading/note on the booking page.
/settext <key> | <new text>
  Change one. e.g. /settext button.next | Continue

FACILITIES & ACTIVITIES
/services
  List what's included in the package (shown on the site and to guides).
/addservice <name>
  e.g. /addservice Bonfire in the evening
/removeservice <number>
  Remove by the number shown in /services.

PRICE
/price
  Show the current price per person and minimum advance payment.
/setprice <amount>
  e.g. /setprice 2800
/setminpay <amount>
  e.g. /setminpay 500

/help
  Show this message.`;

function formatTourList() {
  const tours = store.getTours();
  if (!tours.length) return 'No tours configured yet.';
  return tours
    .map((t) => `• ${t.name} (id: ${t.id})\n  Chat ID: ${t.chatId || '— not set —'}`)
    .join('\n\n');
}

// Splits "/setchatid krem-chympe -100123" into ['setchatid', 'krem-chympe', '-100123']
function parseCommand(text) {
  const trimmed = text.trim();
  const [cmdRaw, ...rest] = trimmed.split(/\s+/);
  const cmd = cmdRaw.replace(/^\//, '').split('@')[0].toLowerCase(); // strip leading / and @BotName
  return { cmd, argString: rest.join(' '), args: rest };
}

/**
 * Handles one incoming Telegram text message. Returns the reply text to
 * send back (via telegram.sendMessage), or null if nothing should be sent
 * (not an admin, not a recognized command, etc.).
 */
async function handleMessage(chatId, text) {
  if (!isAdmin(chatId)) return null;
  if (typeof text !== 'string' || !text.trim().startsWith('/')) return null;

  const { cmd, argString, args } = parseCommand(text);

  try {
    switch (cmd) {
      case 'start':
      case 'help':
        return HELP_TEXT;

      case 'tours':
        return formatTourList();

      case 'setchatid': {
        const [tourId, chatIdArg] = args;
        if (!tourId || !chatIdArg || !CHAT_ID_PATTERN.test(chatIdArg)) {
          return 'Usage: /setchatid <tourId> <chatId>\ne.g. /setchatid krem-chympe -100123456789';
        }
        const updated = await store.setChatId(tourId, chatIdArg);
        if (!updated) return `No tour found with id "${tourId}". Send /tours to see valid ids.`;
        return `Chat ID for "${updated.name}" updated to ${updated.chatId}.`;
      }

      case 'removechatid': {
        const [tourId] = args;
        if (!tourId) return 'Usage: /removechatid <tourId>';
        const updated = await store.removeChatId(tourId);
        if (!updated) return `No tour found with id "${tourId}". Send /tours to see valid ids.`;
        return `Chat ID removed for "${updated.name}". Bookings for this tour won't be sent anywhere until a new Chat ID is set.`;
      }

      case 'addtour': {
        if (!argString) return 'Usage: /addtour <name> | <chatId (optional)>';
        const [namePart, chatIdPart] = argString.split('|').map((s) => s && s.trim());
        if (!namePart) return 'Usage: /addtour <name> | <chatId (optional)>';
        if (chatIdPart && !CHAT_ID_PATTERN.test(chatIdPart)) {
          return 'That Chat ID doesn\'t look right — it should look like -100123456789.';
        }
        const tour = await store.addTour({ name: namePart, chatId: chatIdPart || undefined });
        return `Added tour "${tour.name}" (id: ${tour.id})${tour.chatId ? `, Chat ID ${tour.chatId}.` : '. No Chat ID set yet — send /setchatid to add one.'}`;
      }

      case 'deletetour': {
        const [tourId] = args;
        if (!tourId) return 'Usage: /deletetour <tourId>';
        const removed = await store.deleteTour(tourId);
        if (!removed) return `No tour found with id "${tourId}". Send /tours to see valid ids.`;
        return `Deleted tour "${removed.name}". Past bookings are unaffected.`;
      }

      case 'text': {
        const content = store.getContent();
        return TEXT_KEYS.map(({ key, label, defaultValue }) => {
          const current = Object.prototype.hasOwnProperty.call(content.text, key)
            ? content.text[key]
            : defaultValue;
          return `${key} — ${label}\n  "${current}"`;
        }).join('\n\n');
      }

      case 'settext': {
        if (!argString.includes('|')) {
          return 'Usage: /settext <key> | <new text>\ne.g. /settext button.next | Continue\n\nSend /text to see all keys.';
        }
        const [key, ...valueParts] = argString.split('|');
        const trimmedKey = key.trim();
        const value = valueParts.join('|').trim();
        if (!TEXT_KEYS.some((t) => t.key === trimmedKey)) {
          return `Unrecognized key "${trimmedKey}". Send /text to see valid keys.`;
        }
        if (!value) return 'The new text can\'t be empty.';
        await store.setTextValue(trimmedKey, value);
        return `Updated "${trimmedKey}" to:\n"${value}"`;
      }

      case 'services': {
        const { package: pkg } = store.getContent();
        if (!pkg.services.length) return 'No facilities/activities listed yet.';
        return pkg.services.map((s, i) => `${i + 1}. ${s}`).join('\n');
      }

      case 'addservice': {
        if (!argString) return 'Usage: /addservice <name>\ne.g. /addservice Bonfire in the evening';
        const content = await store.addService(argString);
        return `Added "${argString}". Current list:\n\n` +
          content.package.services.map((s, i) => `${i + 1}. ${s}`).join('\n');
      }

      case 'removeservice': {
        const n = Number(args[0]);
        if (!Number.isInteger(n) || n < 1) return 'Usage: /removeservice <number>\nSend /services to see the numbers.';
        const result = await store.removeService(n);
        if (!result) return `No item #${n}. Send /services to see the current list.`;
        return `Removed "${result.removed}". Current list:\n\n` +
          (result.content.package.services.map((s, i) => `${i + 1}. ${s}`).join('\n') || '(none left)');
      }

      case 'price': {
        const { package: pkg } = store.getContent();
        return `Price per person: ₹${pkg.pricePerPerson}\nMinimum advance payment: ₹${pkg.minPayAmount}`;
      }

      case 'setprice': {
        const amount = Number(args[0]);
        if (!Number.isFinite(amount) || amount <= 0) return 'Usage: /setprice <amount>\ne.g. /setprice 2800';
        await store.setPackageField('pricePerPerson', amount);
        return `Price per person updated to ₹${amount}.`;
      }

      case 'setminpay': {
        const amount = Number(args[0]);
        if (!Number.isFinite(amount) || amount <= 0) return 'Usage: /setminpay <amount>\ne.g. /setminpay 500';
        await store.setPackageField('minPayAmount', amount);
        return `Minimum advance payment updated to ₹${amount}.`;
      }

      default:
        return `Unrecognized command. Send /help to see what's available.`;
    }
  } catch (err) {
    console.error('[admin-bot] error handling command:', err.message);
    return 'Something went wrong running that command. Please try again.';
  }
}

module.exports = { isAdmin, handleMessage, getAdminChatIds };
