// OPTIONAL demo data — fills the dashboard with realistic sample incidents so
// you can see how it looks and demo it to management.
// Run:   node --disable-warning=ExperimentalWarning scripts/seed.js
// Reset: delete the file data/safety.db and restart the app for an empty system.
//
// NOTE: this inserts directly into the DB and does NOT send any email/WhatsApp.
import { db } from '../db.js';

const UNITS = ['UNIT1', 'UNIT2', 'UNIT3', 'UNIT5RYK', 'UNIT6', 'UNIT7', 'UNIT8', 'UNIT9'];
const TYPES = ['Injury', 'Near-miss', 'Fire', 'Chemical spill', 'Equipment damage', 'Electrical', 'Property damage'];
const SEV = ['Minor', 'Serious', 'Major', 'Fatal'];

const DESCRIPTIONS = [
  'Operator slipped on spilled oil near the molding machine.',
  'Hydraulic hose burst, hot oil sprayed near the guard.',
  'Worker\'s hand came close to moving die — guard was open.',
  'Small fire in the electrical panel, extinguished with CO2.',
  'Forklift nearly hit a pedestrian at the warehouse corner.',
  'Chemical drum leaked in the storage area.',
  'Employee cut finger while trimming plastic parts.',
  'Overhead crane load swung and hit a rack.',
  'Exposed wiring found near the compressor.',
  'Steam valve released without warning, minor burn.',
];

function daysAgoIso(days, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, Math.floor((days * 7) % 60), 0, 0);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 19);
}

const insert = db.prepare(`
  INSERT INTO incidents (unit, location, occurred_at, type, severity, description,
    injured_person, reporter_name, reporter_contact, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const existing = db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n;
if (existing > 0) {
  console.log(`DB already has ${existing} incidents — not seeding again. (Delete data/safety.db to reset.)`);
  process.exit(0);
}

// Spread ~28 incidents over the last ~150 days.
let count = 0;
for (let i = 0; i < 28; i++) {
  const days = Math.floor((i * 150) / 28) + (i % 5);
  const unit = UNITS[i % UNITS.length];
  const type = TYPES[i % TYPES.length];
  // Mostly Minor, some Serious/Major, occasional Fatal — exercises all paths.
  const severity = SEV[i % 9 === 0 ? 3 : (i % 4 === 0 ? 2 : (i % 3 === 0 ? 1 : 0))];
  const status = i % 4 === 0 ? 'Closed' : (i % 3 === 0 ? 'Under Investigation' : 'Open');
  const created = daysAgoIso(days);
  const info = insert.run(
    unit,
    ['Molding hall', 'Warehouse', 'Extrusion line', 'Assembly area', 'Electrical room'][i % 5],
    created,
    type,
    severity,
    DESCRIPTIONS[i % DESCRIPTIONS.length],
    type === 'Injury' ? 'Worker #' + (1000 + i) : null,
    ['Ali', 'Bilal', 'Sana', 'Kamran', 'Ahmed'][i % 5],
    '030012345' + (i % 90 + 10),
    status,
    created,
    created,
  );
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE incidents SET ref_no=? WHERE id=?').run(`INC-${new Date(created).getFullYear()}-${String(id).padStart(4, '0')}`, id);

  // Add an investigation + CAPA to some incidents.
  if (i % 3 === 0) {
    db.prepare(`INSERT INTO investigations (incident_id, what_happened, how_happened, root_cause, immediate_actions, investigated_by, investigated_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      id,
      'Detailed account of the event.',
      'Sequence of events leading to the incident.',
      'Why 1: guard was open. Why 2: no interlock. Why 3: interlock never installed. Root cause: machine commissioned without safety interlock.',
      'Machine stopped, area cordoned off, first aid given.',
      'Safety Officer',
      created.slice(0, 10),
      created,
    );
    db.prepare(`INSERT INTO capa (incident_id, action, kind, owner, due_date, status, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, 'Install safety interlock on the machine guard.', 'Preventive', 'Maintenance Head', daysAgoIso(days - 20).slice(0, 10), i % 4 === 0 ? 'Done' : 'Open', created);
    db.prepare(`INSERT INTO capa (incident_id, action, kind, owner, due_date, status, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, 'Retrain operators on guarding SOP.', 'Corrective', 'Unit Manager', daysAgoIso(days - 10).slice(0, 10), i % 2 === 0 ? 'In Progress' : 'Open', created);
  }
  count++;
}

console.log(`Seeded ${count} demo incidents. Open the dashboard to view.`);
