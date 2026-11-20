// Generates public/samples/form.pdf: a fillable test form with every common field type.
// Run with `npm run sample`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples', 'form.pdf');

const doc = await PDFDocument.create();
doc.setTitle('PDF Studio Form Sample');
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const form = doc.getForm();
const page = doc.addPage([612, 792]);

const label = (text, x, y) => page.drawText(text, { x, y, size: 11, font, color: rgb(0.25, 0.25, 0.3) });
page.drawText('Membership Application', { x: 72, y: 720, size: 22, font: bold, color: rgb(0.2, 0.33, 0.88) });
page.drawText('A sample form for testing PDF Studio', { x: 72, y: 698, size: 11, font, color: rgb(0.45, 0.45, 0.5) });

label('Full name', 72, 660);
form.createTextField('applicant.name').addToPage(page, { x: 72, y: 630, width: 300, height: 24, font });

label('Email', 72, 610);
const email = form.createTextField('applicant.email');
email.addToPage(page, { x: 72, y: 580, width: 300, height: 24, font });
email.enableRequired();

label('Postcode (6 characters)', 400, 610);
const code = form.createTextField('applicant.postcode');
code.setMaxLength(6);
code.enableCombing();
code.addToPage(page, { x: 400, y: 580, width: 140, height: 24, font });

label('Membership type', 72, 550);
const type = form.createRadioGroup('membership');
type.addOptionToPage('basic', page, { x: 72, y: 525, width: 16, height: 16 });
label('Basic', 94, 528);
type.addOptionToPage('plus', page, { x: 162, y: 525, width: 16, height: 16 });
label('Plus', 184, 528);
type.addOptionToPage('pro', page, { x: 252, y: 525, width: 16, height: 16 });
label('Pro', 274, 528);
type.select('basic');

label('Country', 72, 495);
const country = form.createDropdown('country');
country.addOptions(['India', 'United Kingdom', 'United States', 'Germany', 'Japan']);
country.addToPage(page, { x: 72, y: 465, width: 200, height: 24, font });

label('Interests', 320, 495);
const interests = form.createOptionList('interests');
interests.addOptions(['Reading', 'Travel', 'Music', 'Sport', 'Cooking']);
interests.enableMultiselect();
interests.addToPage(page, { x: 320, y: 395, width: 200, height: 94, font });

label('About you', 72, 440);
const about = form.createTextField('about');
about.enableMultiline();
about.addToPage(page, { x: 72, y: 340, width: 220, height: 94, font });

const terms = form.createCheckBox('agree.terms');
terms.addToPage(page, { x: 72, y: 300, width: 16, height: 16 });
label('I agree to the terms', 94, 303);
const news = form.createCheckBox('agree.newsletter');
news.addToPage(page, { x: 72, y: 275, width: 16, height: 16 });
news.check();
label('Send me the newsletter', 94, 278);

label('Approved by (read-only)', 72, 240);
const approver = form.createTextField('office.approver');
approver.setText('Membership office');
approver.enableReadOnly();
approver.addToPage(page, { x: 72, y: 210, width: 220, height: 24, font });

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, await doc.save());
console.log(`Wrote ${out}`);
