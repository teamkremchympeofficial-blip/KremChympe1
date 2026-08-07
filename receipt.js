// lib/receipt.js
//
// Generates a real, booking-specific PDF payment receipt — as opposed to
// simply handing back the raw payment screenshot the visitor uploaded.
// Every field on the receipt (Booking ID, submitted date/time, amount paid)
// comes straight from the booking record, so a new, unique receipt is
// produced fresh on every call — nothing is cached or reused between
// bookings.
//
// Uses pdfkit (pure JS, no native/binary dependencies), so it installs and
// runs cleanly on Render or any other Node host with no extra setup.

const PDFDocument = require('pdfkit');

function inr(amount) {
  const n = Number(amount) || 0;
  return `Rs. ${n.toLocaleString('en-IN')}`;
}

function row(doc, label, value, opts = {}) {
  const y = doc.y;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font('Helvetica').fontSize(opts.size || 11).fillColor('#666666')
    .text(label, doc.page.margins.left, y, { width: pageWidth * 0.55 });

  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 11).fillColor('#111111')
    .text(value, doc.page.margins.left, y, { width: pageWidth, align: 'right' });

  doc.moveDown(0.65);
}

function divider(doc) {
  const y = doc.y;
  doc.strokeColor('#e2e2e2').lineWidth(1)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke();
  doc.moveDown(0.8);
}

/**
 * Builds a PDF receipt for one confirmed booking and returns it as a Buffer.
 * @param {object} booking - a booking record from lib/store.js
 * @param {object} [tour] - the tour record (for a friendly title), optional
 * @returns {Promise<Buffer>}
 */
function generateReceiptPdf(booking, tour) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A5', margin: 42 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const balance = Math.max((Number(booking.total) || 0) - (Number(booking.paidNow) || 0), 0);

      // Header
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#188038')
        .text('Payment Receipt', { align: 'center' });
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(10).fillColor('#666666')
        .text((tour && tour.name) || booking.tourName || 'Book Adventure With US', { align: 'center' });
      doc.moveDown(1.1);
      divider(doc);

      // Booking identity
      row(doc, 'Booking ID', booking.id, { bold: true, size: 12 });
      row(doc, 'Receipt Issued', new Date().toLocaleString('en-IN', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
      }));
      row(doc, 'Booking Submitted', booking.bookingTime || '—');
      row(doc, 'Status', 'CONFIRMED', { bold: true });
      doc.moveDown(0.3);
      divider(doc);

      // Customer / tour details
      row(doc, 'Name', booking.name || '—');
      if (booking.phone) row(doc, 'Phone', booking.phone);
      row(doc, 'Tour Date', booking.date || '—');
      row(doc, 'Persons', String(booking.persons || '—'));
      row(doc, 'Payment Method', booking.paymentMethod || '—');
      doc.moveDown(0.3);
      divider(doc);

      // Amounts — paidNow is exactly what the visitor entered as their
      // advance payment amount on the booking form, never a computed guess.
      row(doc, 'Amount Paid (Advance)', inr(booking.paidNow), { bold: true, size: 13 });
      row(doc, 'Total Amount', inr(booking.total));
      row(doc, 'Balance Due on Arrival', inr(balance));

      doc.moveDown(1);
      divider(doc);
      doc.font('Helvetica').fontSize(9).fillColor('#999999')
        .text('This receipt confirms the advance payment recorded for this booking. Please retain it for your records.', {
          align: 'center',
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateReceiptPdf };
