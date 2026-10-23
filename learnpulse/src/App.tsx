import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, ArrowUpRight, BarChart3, BookOpen, Brain, CalendarDays,
  CheckCircle2, ChevronDown, Download, FileText, GraduationCap, LayoutDashboard,
  Library, Menu, Paperclip, Search, ShieldCheck, Sparkles, Target, UploadCloud,
  UserRound, Users, X, Zap,
} from 'lucide-react';
import { demoSections } from './lib/demoData';
import { insightFor, sectionStats, studentAverage, subjectAverage } from './lib/analytics';
import { recommendMaterials } from './lib/rag';
import { requestGroqReview } from './lib/groq';
import type { AiReview, CourseMaterial, CourseSection, Role, StudentRecord } from './lib/types';

const STORE_KEY = 'learnpulse.sections.v2';

function loadSections(): CourseSection[] {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (!saved) return demoSections;
    const parsed = JSON.parse(saved) as CourseSection[];
    return Array.isArray(parsed) && parsed.length && parsed.every((item) => item.id && Array.isArray(item.students) && Array.isArray(item.subjects) && Array.isArray(item.materials))
      ? parsed
      : demoSections;
  } catch {
    return demoSections;
  }
}

function cleanText(value: unknown) {
  return String(value ?? '').trim();
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function parseRows(rows: Record<string, unknown>[], sectionId: string): { students: StudentRecord[]; subjects: string[] } | null {
  if (!rows.length) return null;
  const headers = Object.keys(rows[0]);
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (terms: string[]) => headers.find((header) => terms.some((term) => clean(header).includes(term)));
  const nameKey = find(['studentname', 'student', 'learner', 'pupil', 'name']);
  const rollKey = find(['rollno', 'rollnumber', 'studentid', 'registration', 'admission', 'roll']);
  const attendanceKey = find(['attendance', 'attend', 'present']);
  const excluded = new Set([nameKey, rollKey, attendanceKey].filter(Boolean));
  const subjects = headers.filter((header) => !excluded.has(header) && rows.some((row) => cleanText(row[header]) !== '' && Number.isFinite(Number(row[header]))));
  if (!subjects.length) return null;
  const students = rows.filter((row) => Object.values(row).some((value) => cleanText(value))).map((row, index) => ({
    id: `${sectionId}-upload-${index + 1}`,
    name: String((nameKey && row[nameKey]) || `Student ${index + 1}`),
    rollNo: String((rollKey && row[rollKey]) || `uploaded-${String(index + 1).padStart(3, '0')}`),
    attendance: attendanceKey && row[attendanceKey] !== '' && row[attendanceKey] !== undefined ? Number(row[attendanceKey]) : undefined,
    marks: Object.fromEntries(subjects.map((subject) => [subject, Number(row[subject]) || 0])),
  }));
  return { students, subjects };
}

async function extractTextExcerpt(file: File): Promise<string | undefined> {
  if (file.size > 20 * 1024 * 1024) throw new Error('Course material files must be 20 MB or smaller.');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (['txt', 'md', 'csv', 'log'].includes(extension ?? '')) return (await file.text()).slice(0, 6000);
  if (extension === 'docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value.slice(0, 6000) || undefined;
  }
  if (extension === 'pdf') {
    const [pdfjsLib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default;
    const loadingTask = pdfjsLib.getDocument({ data: await file.arrayBuffer() });
    const document = await loadingTask.promise;
    const pages = Math.min(document.numPages, 12);
    const pageTexts: string[] = [];
    for (let number = 1; number <= pages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => 'str' in item ? item.str : '').filter(Boolean).join(' '));
      if (pageTexts.join(' ').length >= 6000) break;
    }
    const excerpt = pageTexts.join(' ').slice(0, 6000).trim();
    await loadingTask.destroy();
    return excerpt || undefined;
  }
  return undefined;
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv(section: CourseSection) {
  const header = ['Student Name', 'Roll No', ...section.subjects, 'Average', 'Attendance'];
  const lines = section.students.map((student) => [student.name, student.rollNo, ...section.subjects.map((subject) => student.marks[subject]), studentAverage(student, section.subjects).toFixed(2), student.attendance ?? '']);
  downloadBlob([header, ...lines].map((row) => row.map(csvCell).join(',')).join('\n'), `${section.code.toLowerCase()}-marks.csv`, 'text/csv;charset=utf-8');
}

async function downloadXlsx(section: CourseSection) {
  const XLSX = await import('xlsx');
  const rows = section.students.map((student) => ({ 'Student Name': student.name, 'Roll No': student.rollNo, ...student.marks, Average: Number(studentAverage(student, section.subjects).toFixed(2)), Attendance: student.attendance ?? '' }));
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Marks');
  XLSX.writeFile(workbook, `${section.code.toLowerCase()}-marks.xlsx`);
}

function downloadIndividualMarks(section: CourseSection, student: StudentRecord) {
  const rows = [
    ['Student Name', student.name], ['Roll No', student.rollNo], ['Course', section.course], ['Section', `${section.code} · ${section.name}`], ['Faculty', section.faculty], ['Term', section.term], ['Attendance', student.attendance ?? 'Not provided'], ['Overall average', `${studentAverage(student, section.subjects).toFixed(2)}%`], [],
    ['Subject', 'Student mark', 'Section subject average', 'Difference'],
    ...section.subjects.map((subject) => [subject, student.marks[subject] ?? '', subjectAverage(section, subject).toFixed(2), ((student.marks[subject] ?? 0) - subjectAverage(section, subject)).toFixed(2)]),
  ];
  downloadBlob(rows.map((row) => row.map(csvCell).join(',')).join('\n'), `${student.rollNo}-marks.csv`, 'text/csv;charset=utf-8');
}

function downloadReport(section: CourseSection, student: StudentRecord, review?: AiReview) {
  const insight = insightFor(section, student);
  const subjectRows = section.subjects.map((subject) => `<tr><td>${escapeHtml(subject)}</td><td>${student.marks[subject] ?? '—'}%</td><td>${subjectAverage(section, subject).toFixed(1)}%</td><td>${((student.marks[subject] ?? 0) - subjectAverage(section, subject)).toFixed(1)} points</td></tr>`).join('');
  const aiSection = review ? `<h2>Groq learning review</h2><p>${escapeHtml(review.summary)}</p><h3>Suggested weekly plan</h3><ul>${review.weeklyPlan.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><h3>Faculty follow-up</h3><p>${escapeHtml(review.facultyFollowUp)}</p>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(student.name)} · LearnPulse report</title><style>body{font-family:Arial;color:#20242a;max-width:760px;margin:40px auto;padding:0 20px}h1{color:#d96925}h2{border-bottom:2px solid #f3d5bd;padding-bottom:8px;color:#9c4e1e}table{border-collapse:collapse;width:100%;margin:14px 0}td,th{border:1px solid #ddd;padding:9px;text-align:left}th{background:#f8eee7}.pill{display:inline-block;background:#fff0e5;padding:8px 12px;border-radius:18px;margin:4px 4px 4px 0}.muted{color:#65707a}</style></head><body><p class="muted">LEARNPULSE · INDIVIDUAL PERFORMANCE REVIEW</p><h1>${escapeHtml(student.name)}</h1><p>Roll no. <b>${escapeHtml(student.rollNo)}</b> · ${escapeHtml(section.course)} · ${escapeHtml(section.code)} · Faculty: ${escapeHtml(section.faculty)}</p><div class="pill">Average ${insight.overall.toFixed(2)}%</div><div class="pill">Class average ${insight.classAverage.toFixed(2)}%</div><div class="pill">Gap ${insight.gap >= 0 ? '+' : ''}${insight.gap.toFixed(2)}</div><div class="pill">Attendance ${student.attendance === undefined ? 'Not provided' : `${student.attendance}%`}</div><h2>Strengths</h2><p>${insight.strengths.map(escapeHtml).join(' ')}</p><h2>Improvement focus</h2><p>${insight.weaknesses.map(escapeHtml).join(' ')}</p><p><b>Next action:</b> ${escapeHtml(insight.recommendation)}</p><h2>Subject review</h2><table><tr><th>Subject</th><th>Student</th><th>Section average</th><th>Difference</th></tr>${subjectRows}</table>${aiSection}<p class="muted">Generated by LearnPulse. Review with the course faculty.</p></body></html>`;
  downloadBlob(html, `${student.rollNo}-performance-report.html`, 'text/html;charset=utf-8');
}

function App() {
  const [role, setRole] = useState<Role>('faculty');
  const [sections, setSections] = useState<CourseSection[]>(loadSections);
  const [sectionId, setSectionId] = useState(() => localStorage.getItem('learnpulse.active-section') || demoSections[0].id);
  const [studentId, setStudentId] = useState(() => localStorage.getItem('learnpulse.active-student') || demoSections[0].students[0]?.id || '');
  const [mobileNav, setMobileNav] = useState(false);
  const [creatingSection, setCreatingSection] = useState(false);
  const section = sections.find((item) => item.id === sectionId) ?? sections[0];
  const selectedStudent = section?.students.find((student) => student.id === studentId) ?? section?.students[0];

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(sections)); } catch { console.warn('LearnPulse could not persist section data in this browser.'); }
  }, [sections]);
  useEffect(() => {
    if (section) localStorage.setItem('learnpulse.active-section', section.id);
  }, [section?.id]);
  useEffect(() => {
    if (selectedStudent) localStorage.setItem('learnpulse.active-student', selectedStudent.id);
  }, [selectedStudent?.id]);

  const setSection = (id: string) => {
    const next = sections.find((item) => item.id === id);
    if (!next) return;
    setSectionId(id);
    setStudentId(next.students[0]?.id ?? '');
  };
  const updateSection = (next: CourseSection) => setSections((current) => current.map((item) => item.id === next.id ? next : item));
  const createSection = (sectionInput: Pick<CourseSection, 'code' | 'name' | 'course' | 'term' | 'faculty' | 'facultyEmail' | 'room' | 'schedule'>) => {
    const created: CourseSection = { ...sectionInput, id: `section-${Date.now()}`, subjects: [], students: [], materials: [] };
    setSections((current) => [...current, created]);
    setSectionId(created.id);
    setStudentId('');
    setCreatingSection(false);
  };
  if (!section) return <div className="empty-state">No sections are available.</div>;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Activity size={18} /></div><div><strong>LearnPulse</strong><span>Education intelligence</span></div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="side-label">Workspace</div>
      <button className="nav-item active"><LayoutDashboard size={17} /><span>Overview</span><ArrowUpRight size={14} /></button>
      <button className="nav-item"><Users size={17} /><span>{role === 'faculty' ? 'Student monitoring' : 'My performance'}</span></button>
      <button className="nav-item"><BookOpen size={17} /><span>Course library</span></button>
      <button className="nav-item"><BarChart3 size={17} /><span>Learning signals</span></button>
      <div className="sidebar-spacer" />
      <div className="privacy-note"><ShieldCheck size={16} /><div><b>Explainable by design</b><span>Marks and comparisons stay visible with every recommendation.</span></div></div>
      <div className="profile-chip"><div className="avatar">{role === 'faculty' ? initials(section.faculty) : initials(selectedStudent?.name || 'Student')}</div><div><b>{role === 'faculty' ? section.faculty : selectedStudent?.name || 'Choose a student'}</b><span>{role === 'faculty' ? 'Faculty workspace' : selectedStudent?.rollNo || section.code}</span></div><ChevronDown size={15} /></div>
    </aside>
    {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
    <main className="main-content">
      <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="breadcrumb"><span>LearnPulse</span><b>/</b><strong>{role === 'faculty' ? 'Faculty portal' : 'Student portal'}</strong></div><div className="top-actions"><div className="role-switch"><button className={role === 'faculty' ? 'selected' : ''} onClick={() => setRole('faculty')}><UserRound size={14} /> Faculty</button><button className={role === 'student' ? 'selected' : ''} onClick={() => setRole('student')}><GraduationCap size={14} /> Student</button></div></div></header>
      {role === 'faculty'
        ? <FacultyView section={section} sections={sections} onSection={setSection} onUpdate={updateSection} onCreateSection={() => setCreatingSection(true)} />
        : <StudentView section={section} sections={sections} student={selectedStudent} onSection={setSection} onStudent={setStudentId} />}
    </main>
    {creatingSection && <NewSectionDialog onCancel={() => setCreatingSection(false)} onCreate={createSection} />}
  </div>;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function SectionSelect({ section, sections, onSection }: { section: CourseSection; sections: CourseSection[]; onSection: (id: string) => void }) {
  return <label className="select-wrap"><span>Active section</span><select value={section.id} onChange={(event) => onSection(event.target.value)}>{sections.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select><ChevronDown size={15} /></label>;
}

function Metric({ label, value, detail, tone = 'default', icon }: { label: string; value: string; detail: string; tone?: string; icon: ReactNode }) {
  return <div className={`metric-card ${tone}`}><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></div>;
}

function FacultyView({ section, sections, onSection, onUpdate, onCreateSection }: { section: CourseSection; sections: CourseSection[]; onSection: (id: string) => void; onUpdate: (section: CourseSection) => void; onCreateSection: () => void }) {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All students');
  const [focused, setFocused] = useState<StudentRecord | null>(null);
  const [uploadNotice, setUploadNotice] = useState('');
  const [editingDetails, setEditingDetails] = useState(false);
  const [draft, setDraft] = useState(section);
  useEffect(() => { setDraft(section); setEditingDetails(false); setFocused(null); }, [section.id]);
  const stats = sectionStats(section);
  const lowAttendance = section.students.filter((student) => student.attendance !== undefined && student.attendance < 75);
  const rows = useMemo(() => section.students.map((student) => ({ student, insight: insightFor(section, student) }))
    .filter(({ student, insight }) => `${student.name} ${student.rollNo}`.toLowerCase().includes(query.toLowerCase())
      && (activeFilter === 'All students' || insight.group === activeFilter || (activeFilter === 'Attendance < 75%' && (student.attendance ?? 100) < 75))), [section, query, activeFilter]);

  const parseMarks = async (file: File) => {
    try {
      const XLSX = await import('xlsx');
      const isCsv = file.name.toLowerCase().endsWith('.csv');
      const workbook = isCsv
        ? XLSX.read(await file.text(), { type: 'string', raw: false })
        : XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const records = XLSX.utils.sheet_to_json(firstSheet, { defval: '' }) as Record<string, unknown>[];
      const parsed = parseRows(records, section.id);
      if (!parsed) { setUploadNotice('No numeric subject columns found. Include student name/roll number plus one or more mark columns.'); return; }
      onUpdate({ ...section, students: parsed.students, subjects: parsed.subjects });
      setUploadNotice(`${parsed.students.length} students and ${parsed.subjects.length} subjects loaded into ${section.code}. Other sections were not changed.`);
    } catch {
      setUploadNotice('That marks file could not be read. Try a CSV or Excel workbook with a header row.');
    }
  };

  const addMaterial = async (file: File) => {
    const subject = section.subjects.find((item) => file.name.toLowerCase().includes(item.toLowerCase().split(' ')[0])) ?? 'All subjects';
    let excerpt: string | undefined;
    try { excerpt = await extractTextExcerpt(file); }
    catch (error) { setUploadNotice(error instanceof Error ? error.message : 'Could not extract text from this file.'); return; }
    const material: CourseMaterial = {
      id: `${section.id}-material-${Date.now()}`,
      name: file.name,
      type: file.name.split('.').pop()?.toUpperCase() ?? 'FILE',
      subject,
      tags: [subject.toLowerCase(), 'faculty upload'],
      source: 'Faculty upload',
      excerpt,
    };
    onUpdate({ ...section, materials: [material, ...section.materials] });
    setUploadNotice(`${file.name} added to ${section.code}. ${excerpt ? 'Text excerpt indexed for AI retrieval.' : 'Resource details are available for course recommendations.'}`);
  };

  const saveDetails = (event: FormEvent) => {
    event.preventDefault();
    onUpdate({ ...draft, code: draft.code.trim(), name: draft.name.trim(), course: draft.course.trim(), faculty: draft.faculty.trim() });
    setEditingDetails(false);
    setUploadNotice(`${section.code} course details saved.`);
  };

  return <div className="page-wrap">
    <section className="hero-row"><div><div className="eyebrow"><span className="live-dot" /> Faculty command center</div><h1>See the signal behind<br /><em>every mark.</em></h1><p className="hero-copy">Monitor section progress, spot weak topics early, and turn course data into a next action for every learner.</p></div><div className="hero-context"><SectionSelect section={section} sections={sections} onSection={onSection} /><button className="secondary-button create-section-button" onClick={onCreateSection}>+ Create course section</button><div className="context-person"><div className="avatar orange">{initials(section.faculty)}</div><div><span>Course faculty</span><b>{section.faculty}</b></div></div></div></section>
    <div className="status-strip"><div><CheckCircle2 size={16} /><span>Section data saves in this browser · marks and analytics update from the selected list</span></div><span className="strip-code">{section.code} · {section.term}</span></div>
    <section className="metrics-grid"><Metric label="Section average" value={`${stats.average.toFixed(1)}%`} detail={`Best ${stats.highest.toFixed(1)}% · lowest ${stats.lowest.toFixed(1)}%`} icon={<Activity size={16} />} tone="orange" /><Metric label="Students monitored" value={String(section.students.length)} detail={`${section.subjects.length} subjects in view`} icon={<Users size={16} />} /><Metric label="Need attention" value={String(section.students.filter((student) => insightFor(section, student).group !== 'Best performance').length)} detail="Targeted follow-up suggested" icon={<Target size={16} />} tone="soft" /><Metric label="Attendance watch" value={String(lowAttendance.length)} detail={lowAttendance.length ? 'Below 75% threshold' : 'No alerts in this section'} icon={<AlertTriangle size={16} />} tone={lowAttendance.length ? 'alert' : 'good'} /></section>
    <section className="workspace-grid"><div className="primary-column">
      <div className="section-heading-row"><div><div className="eyebrow">Section monitor</div><h2>Student performance</h2></div><div className="table-tools"><div className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or roll no." /></div></div></div>
      <div className="filter-row">{['All students', 'Best performance', 'Needs a little improvement', 'Needs focused improvement', 'Attendance < 75%'].map((filter) => <button key={filter} className={activeFilter === filter ? 'filter active' : 'filter'} onClick={() => setActiveFilter(filter)}>{filter}</button>)}</div>
      <div className="table-shell"><table className="student-table"><thead><tr><th>Student</th><th>Average</th><th>Class gap</th><th>Attendance</th><th>Signal</th><th /></tr></thead><tbody>{rows.map(({ student, insight }) => <tr key={student.id} onClick={() => setFocused(student)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && setFocused(student)}><td><div className="student-cell"><div className="mini-avatar">{initials(student.name)}</div><div><b>{student.name}</b><span>{student.rollNo}</span></div></div></td><td><strong>{insight.overall.toFixed(1)}%</strong><span className="cell-sub">{insight.level}</span></td><td><span className={insight.gap >= 0 ? 'gap positive' : 'gap negative'}>{insight.gap >= 0 ? '+' : ''}{insight.gap.toFixed(1)}</span></td><td><span className={student.attendance !== undefined && student.attendance < 75 ? 'attendance low' : 'attendance'}>{student.attendance === undefined ? '—' : `${student.attendance}%`}</span></td><td><span className={`signal ${insight.group.includes('Best') ? 'signal-good' : insight.group.includes('focused') ? 'signal-risk' : 'signal-mid'}`}>{insight.group.replace('Needs ', '')}</span></td><td><ArrowUpRight size={15} className="row-arrow" /></td></tr>)}</tbody></table>{!rows.length && <div className="empty-state">{section.students.length ? 'No students match this filter.' : 'No student marks yet. Upload a CSV/XLSX list to populate this section.'}</div>}</div>
      <div className="section-heading-row section-gap"><div><div className="eyebrow">Subject signals</div><h2>Where the class needs support</h2></div><span className="muted">Compared with subject average</span></div><div className="subject-grid">{section.subjects.length ? section.subjects.map((subject) => { const avg = subjectAverage(section, subject); const weakCount = section.students.filter((student) => student.marks[subject] < avg).length; return <div className="subject-card" key={subject}><div className="subject-icon"><BarChart3 size={17} /></div><div><b>{subject}</b><span>{weakCount} students below subject average</span></div><strong>{avg.toFixed(1)}%</strong><div className="progress"><i style={{ width: `${Math.min(avg, 100)}%` }} /></div></div>; }) : <div className="empty-state">Subject analytics appear after a marks list is uploaded.</div>}</div>
    </div><aside className="secondary-column">
      <div className="panel upload-panel"><div className="panel-kicker"><UploadCloud size={16} /> Faculty uploads</div><h3>Bring the course<br /><em>into focus.</em></h3><p>Upload a marks list for this section or add course materials. Data remains separate by section.</p><label className="upload-zone"><input type="file" accept=".csv,.xlsx,.xls" onChange={(event) => event.target.files?.[0] && parseMarks(event.target.files[0])} /><FileText size={21} /><b>Upload / replace marks list</b><span>CSV or Excel · student, roll, subject marks, attendance</span></label><label className="upload-zone compact"><input type="file" accept=".pdf,.doc,.docx,.txt,.md,.csv,.ppt,.pptx" onChange={(event) => event.target.files?.[0] && addMaterial(event.target.files[0])} /><Paperclip size={18} /><b>Add course material</b><span>Notes, syllabus, papers, lab manuals</span></label>{uploadNotice && <div className="upload-notice"><CheckCircle2 size={15} />{uploadNotice}</div>}</div>
      <div className="panel course-panel"><div className="panel-kicker"><BookOpen size={16} /> Course details</div>{editingDetails ? <form className="course-edit-form" onSubmit={saveDetails}><h3>Edit section details</h3>{(['code', 'name', 'course', 'term', 'faculty', 'facultyEmail', 'schedule', 'room'] as const).map((field) => <label key={field}><span>{field === 'facultyEmail' ? 'Faculty email' : field === 'code' ? 'Section code' : field === 'name' ? 'Section name' : field === 'course' ? 'Course' : field === 'term' ? 'Term' : field === 'faculty' ? 'Faculty name' : field === 'schedule' ? 'Schedule' : 'Room'}</span><input value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} required={['code', 'name', 'course', 'faculty'].includes(field)} /></label>)}<div className="form-actions"><button className="primary-button" type="submit">Save course details</button><button className="secondary-button" type="button" onClick={() => { setDraft(section); setEditingDetails(false); }}>Cancel</button></div></form> : <><h3>{section.course}</h3><div className="detail-list"><div><span>Section</span><b>{section.code} · {section.name}</b></div><div><span>Faculty</span><b>{section.faculty}{section.facultyEmail ? ` · ${section.facultyEmail}` : ''}</b></div><div><span>Term</span><b>{section.term}</b></div><div><span>Schedule</span><b>{section.schedule || 'Not set'}</b></div><div><span>Room</span><b>{section.room || 'Not set'}</b></div></div><button className="text-button" onClick={() => setEditingDetails(true)}>Edit course and faculty details <ArrowUpRight size={14} /></button></>}</div>
      <div className="panel library-panel"><div className="section-heading-row compact-row"><div><div className="panel-kicker"><Library size={15} /> Course library</div><h3>{section.materials.length} learning resources</h3></div><span className="tiny-badge">RAG-ready</span></div><div className="material-list">{section.materials.slice(0, 6).map((material) => <div className="material-row" key={material.id}><div className="material-icon"><FileText size={15} /></div><div><b>{material.name}</b><span>{material.subject} · {material.type}{material.excerpt ? ' · text indexed' : ''}</span></div><ArrowUpRight size={14} /></div>)}{!section.materials.length && <div className="muted empty-materials">Add a course resource to make it available for recommendations.</div>}</div></div>
    </aside></section>
    {focused && <ReportCard section={section} student={focused} onClose={() => setFocused(null)} />}
    <div className="bottom-actions"><button className="secondary-button" onClick={() => downloadCsv(section)}><Download size={15} /> Download section CSV</button><button className="secondary-button" onClick={() => downloadXlsx(section)}><Download size={15} /> Download section Excel</button></div>
  </div>;
}

function NewSectionDialog({ onCancel, onCreate }: { onCancel: () => void; onCreate: (input: Pick<CourseSection, 'code' | 'name' | 'course' | 'term' | 'faculty' | 'facultyEmail' | 'room' | 'schedule'>) => void }) {
  const [form, setForm] = useState({ code: '', name: '', course: '', term: '', faculty: '', facultyEmail: '', room: '', schedule: '' });
  const submit = (event: FormEvent) => { event.preventDefault(); onCreate(form); };
  return <div className="report-overlay"><form className="report-drawer section-dialog" onSubmit={submit}><div className="drawer-head"><div><div className="eyebrow">New course section</div><h2>Set up a section</h2><span>Its marks and resources will stay separate from other sections.</span></div><button className="icon-button" type="button" onClick={onCancel} aria-label="Close"><X size={18} /></button></div><div className="dialog-fields">{(['code', 'name', 'course', 'term', 'faculty', 'facultyEmail', 'schedule', 'room'] as const).map((field) => <label key={field}><span>{field === 'facultyEmail' ? 'Faculty email' : field === 'code' ? 'Section code' : field === 'name' ? 'Section name' : field === 'course' ? 'Course' : field === 'term' ? 'Term' : field === 'faculty' ? 'Faculty name' : field === 'schedule' ? 'Schedule' : 'Room'}</span><input value={form[field]} onChange={(event) => setForm({ ...form, [field]: event.target.value })} required={['code', 'name', 'course', 'faculty'].includes(field)} /></label>)}</div><div className="drawer-actions"><button className="primary-button" type="submit">Create section</button><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button></div></form></div>;
}

function AiReview({ review, error, materials }: { review: AiReview | null; error: string; materials: CourseMaterial[] }) {
  if (error) return <div className="ai-state error-state"><b>Groq review unavailable</b><span>{error}</span><small>Numeric marks and the evidence-based local review remain available.</small></div>;
  if (!review) return null;
  return <div className="ai-review-content"><div className="ai-summary"><div className="panel-kicker"><Sparkles size={15} /> Groq detailed review{review.model ? ` · ${review.model}` : ''}</div><p>{review.summary}</p></div>{review.strengths.length > 0 && <div className="insight-block"><div className="insight-title"><CheckCircle2 size={15} /> Strengths</div>{review.strengths.map((item) => <p key={item}>{item}</p>)}</div>}{review.focusAreas.map((area, index) => <div className="ai-focus" key={`${area.subject}-${index}`}><div><b>{area.subject}</b><span>{area.evidence}</span></div><p>{area.action}</p></div>)}{review.weeklyPlan.length > 0 && <div className="ai-plan"><b>Suggested study plan</b><ol>{review.weeklyPlan.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol></div>}{review.recommendedMaterials.length > 0 && <div className="ai-plan"><b>Retrieved course materials</b>{review.recommendedMaterials.map((item) => <div className="ai-material" key={item.materialId}><BookOpen size={14} /><span>{materials.find((material) => material.id === item.materialId)?.name ?? 'Course resource'}: {item.reason}</span></div>)}</div>}<div className="ai-followup"><b>Faculty follow-up</b><p>{review.facultyFollowUp}</p></div></div>;
}

function StudentView({ section, sections, student, onSection, onStudent }: { section: CourseSection; sections: CourseSection[]; student?: StudentRecord; onSection: (id: string) => void; onStudent: (id: string) => void }) {
  const [studentQuery, setStudentQuery] = useState('');
  const [review, setReview] = useState<AiReview | null>(null);
  const [aiError, setAiError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { setReview(null); setAiError(''); }, [section.id, student?.id]);
  const matches = section.students.filter((candidate) => `${candidate.name} ${candidate.rollNo}`.toLowerCase().includes(studentQuery.toLowerCase()));
  const insight = student ? insightFor(section, student) : null;
  const recommendations = student ? recommendMaterials(section, student) : [];
  const runReview = async () => {
    if (!student) return;
    setLoading(true); setAiError('');
    try { setReview(await requestGroqReview(section, student)); }
    catch (error) { setAiError(error instanceof Error ? error.message : 'Could not generate the study plan.'); }
    finally { setLoading(false); }
  };

  return <div className="page-wrap student-page"><section className="hero-row"><div><div className="eyebrow"><span className="live-dot" /> Personal learning view</div><h1>Your next win<br /><em>starts here.</em></h1><p className="hero-copy">A clear view of your marks, your position in the section, and the most useful next study move.</p></div><div className="hero-context"><SectionSelect section={section} sections={sections} onSection={onSection} /><div className="student-picker"><Search size={15} /><input value={studentQuery} onChange={(event) => setStudentQuery(event.target.value)} placeholder="Find your name or roll no." aria-label="Find a student in this section" />{studentQuery && matches.length > 0 && <div className="picker-menu">{matches.slice(0, 5).map((candidate) => <button key={candidate.id} onClick={() => { onStudent(candidate.id); setStudentQuery(''); }}>{candidate.name}<span>{candidate.rollNo}</span></button>)}</div>}</div></div></section>
    {!student || !insight ? <div className="panel no-roster"><div className="panel-kicker"><Users size={16} /> Section enrollment</div><h3>No students in {section.code} yet</h3><p>Ask faculty to upload this section's marks list. After upload, choose your name from this section's roster to see your marks and course feedback.</p><div className="identity-course"><span>Course faculty</span><b>{section.faculty}</b></div><p>{section.course} · {section.term}</p></div> : <>
      <div className="identity-banner"><div className="avatar orange large">{initials(student.name)}</div><div><span>Viewing {section.code}</span><h2>{student.name}</h2><p>{section.course} · {section.term}</p></div><div className="identity-course"><span>Course faculty</span><b>{section.faculty}</b><small>{section.facultyEmail}</small></div></div>
      <section className="metrics-grid student-metrics"><Metric label="My average" value={`${insight.overall.toFixed(1)}%`} detail={`${insight.gap >= 0 ? '+' : ''}${insight.gap.toFixed(1)} vs section average`} icon={<Sparkles size={16} />} tone="orange" /><Metric label="Attendance" value={student.attendance === undefined ? '—' : `${student.attendance}%`} detail={student.attendance !== undefined && student.attendance < 75 ? 'Needs attention' : 'On track'} icon={<CalendarDays size={16} />} tone={student.attendance !== undefined && student.attendance < 75 ? 'alert' : 'good'} /><Metric label="Current signal" value={insight.group.replace('Needs ', '')} detail={insight.level} icon={<Target size={16} />} /><Metric label="Focus subject" value={insight.weakSubject} detail={`${insight.weakScore.toFixed(1)}% · next opportunity`} icon={<Brain size={16} />} tone="soft" /></section>
      <section className="student-grid"><div className="primary-column"><div className="panel personal-panel"><div className="panel-kicker"><Sparkles size={16} /> Personal performance note</div><h3>{insight.gap >= 0 ? 'Your momentum is visible.' : 'Your next improvement is specific.'}</h3><p>{insight.gap >= 0 ? `You are ${insight.gap.toFixed(1)} points above the section average. Keep your strongest habits and use the focus area below to move further ahead.` : `You are ${Math.abs(insight.gap).toFixed(1)} points below the section average. Start with ${insight.weakSubject}, then use the recommended material.`}</p><div className="signal-callout"><Target size={18} /><div><b>Recommended next action</b><span>{insight.recommendation}</span></div></div><button className="primary-button groq-button" onClick={runReview} disabled={loading}><Sparkles size={15} />{loading ? 'Building your study plan…' : review ? 'Refresh Groq study plan' : 'Get my Groq study plan'}</button><AiReview review={review} error={aiError} materials={section.materials} /></div>
      <div className="section-heading-row section-gap"><div><div className="eyebrow">Subject review</div><h2>Your marks in context</h2></div><span className="muted">Student vs section average</span></div><div className="subject-grid student-subjects">{section.subjects.map((subject) => { const score = student.marks[subject] ?? 0; const avg = subjectAverage(section, subject); const positive = score >= avg; return <div className="subject-card" key={subject}><div className={`subject-icon ${positive ? 'good' : 'risk'}`}>{positive ? <CheckCircle2 size={17} /> : <Target size={17} />}</div><div><b>{subject}</b><span>{positive ? 'Above subject average' : 'Improvement focus'}</span></div><strong>{score}%</strong><div className="progress"><i className={positive ? 'progress-good' : 'progress-risk'} style={{ width: `${Math.min(score, 100)}%` }} /></div><small>{score >= avg ? '+' : ''}{(score - avg).toFixed(1)} vs subject average</small></div>; })}</div></div>
      <aside className="secondary-column"><div className="panel recommendation-panel"><div className="panel-kicker"><Zap size={16} /> Suggested study path</div><h3>Materials selected<br /><em>for {insight.weakSubject}.</em></h3><p>Resources are retrieved from this section's course library and matched to the improvement focus.</p><div className="material-list">{recommendations.map(({ material, reason }) => <div className="recommendation-row" key={material.id}><div className="material-icon"><BookOpen size={15} /></div><div><b>{material.name}</b><span>{material.type} · {reason}</span></div><ArrowUpRight size={14} /></div>)}{!recommendations.length && <div className="muted">No course resources have been added for this section yet.</div>}</div></div>
      <div className="panel attendance-panel"><div className="panel-kicker"><ShieldCheck size={16} /> Explainable view</div><h3>What the faculty sees</h3><p>Your section comparison uses this section's marks and attendance. The AI study plan uses course details and matching materials, not hidden score changes.</p><button className="text-button" onClick={() => downloadReport(section, student, review ?? undefined)}>Download my detailed report <ArrowUpRight size={14} /></button><button className="text-button download-marks-button" onClick={() => downloadIndividualMarks(section, student)}><Download size={14} /> Download my marks CSV</button></div></aside></section>
    </>}
  </div>;
}

function ReportCard({ section, student, onClose }: { section: CourseSection; student: StudentRecord; onClose: () => void }) {
  const insight = insightFor(section, student);
  const [tab, setTab] = useState<'overview' | 'subjects' | 'groq'>('overview');
  const [review, setReview] = useState<AiReview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const recommendations = recommendMaterials(section, student);
  const runReview = async () => {
    setLoading(true); setError('');
    try { setReview(await requestGroqReview(section, student)); setTab('groq'); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not generate the detailed review.'); setTab('groq'); }
    finally { setLoading(false); }
  };
  return <div className="report-overlay" role="presentation"><div className="report-drawer" role="dialog" aria-modal="true" aria-label={`Individual review for ${student.name}`}><div className="drawer-head"><div><div className="eyebrow">Individual review · {section.code}</div><h2>{student.name}</h2><span>{student.rollNo} · {section.course} · {section.faculty}</span></div><button className="icon-button" onClick={onClose} aria-label="Close review"><X size={18} /></button></div><div className="drawer-tabs"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button><button className={tab === 'subjects' ? 'active' : ''} onClick={() => setTab('subjects')}>Subject detail</button><button className={tab === 'groq' ? 'active' : ''} onClick={() => setTab('groq')}>Groq review</button></div>
    {tab === 'overview' ? <><div className="drawer-metrics"><Metric label="Average" value={`${insight.overall.toFixed(1)}%`} detail={`Class ${insight.classAverage.toFixed(1)}%`} icon={<Activity size={15} />} tone="orange" /><Metric label="Attendance" value={student.attendance === undefined ? '—' : `${student.attendance}%`} detail={insight.attendanceAlert ?? 'On track'} icon={<CalendarDays size={15} />} /></div><div className="insight-block"><div className="insight-title"><CheckCircle2 size={16} /> Strengths</div>{insight.strengths.map((item) => <p key={item}>{item}</p>)}</div><div className="insight-block warning"><div className="insight-title"><Target size={16} /> Improvement focus</div>{insight.weaknesses.map((item) => <p key={item}>{item}</p>)}<p className="recommendation"><b>Next action:</b> {insight.recommendation}</p></div><div className="review-resources"><b>Matched section materials</b>{recommendations.map(({ material, reason }) => <p key={material.id}>{material.name} — {reason}</p>)}</div></> : tab === 'subjects' ? <div className="drawer-subjects">{section.subjects.map((subject) => <div className="drawer-subject" key={subject}><div><b>{subject}</b><span>Student {student.marks[subject] ?? '—'}% · Section {subjectAverage(section, subject).toFixed(1)}%</span></div><strong className={(student.marks[subject] ?? 0) >= subjectAverage(section, subject) ? 'text-good' : 'text-risk'}>{(student.marks[subject] ?? 0) >= subjectAverage(section, subject) ? 'Above average' : 'Improve'}</strong></div>)}</div> : <><button className="primary-button groq-button" onClick={runReview} disabled={loading}><Sparkles size={15} />{loading ? 'Reviewing marks and course resources…' : review ? 'Refresh detailed Groq review' : 'Generate detailed Groq review'}</button><AiReview review={review} error={error} materials={section.materials} /></>}
    <div className="drawer-actions"><button className="primary-button" onClick={() => downloadIndividualMarks(section, student)}><Download size={15} /> Download individual marks</button><button className="secondary-button" onClick={() => downloadReport(section, student, review ?? undefined)}><FileText size={15} /> Download detailed report</button><button className="secondary-button" onClick={onClose}>Close review</button></div></div></div>;
}

export default App;
