/**
 * 内容脚本：同时支持人大本科与研究生课表。
 *   - 本科：jw.ruc.edu.cn「课表查看」页面
 *   - 研究生：yjs2.ruc.edu.cn「我的课表 → 学生课程表」iframe
 * 响应 popup 的 RUC_EXTRACT 消息。
 */
'use strict';

// ===== 本科教学管理一体化信息服务平台 =====

const UNDERGRAD_SLOT_RE = /^([^/\s]+)\/(\d+)-(\d+)节\/(\d+)-(\d+)周(单周|双周)?$/;

function parseUndergraduateScheduleCell(text) {
  const match = text.match(UNDERGRAD_SLOT_RE);
  if (!match) return null;
  const slot = {
    location: match[1].trim(),
    startSection: Number(match[2]),
    endSection: Number(match[3]),
    startWeek: Number(match[4]),
    endWeek: Number(match[5]),
    weekFlag: match[6] || '',
  };
  if (slot.weekFlag === '单周') slot.oddWeeksOnly = true;
  if (slot.weekFlag === '双周') slot.evenWeeksOnly = true;
  return slot;
}

function parseUndergraduateCell(cell) {
  const out = [];
  let currentName = null;
  let pending = []; // 自上一个 slot 以来的叶子文本行
  for (const div of cell.querySelectorAll('div')) {
    if (div.children.length !== 0) continue;
    const text = (div.textContent || '').trim();
    if (!text) continue;
    const style = div.getAttribute('style') || '';
    const slot = parseUndergraduateScheduleCell(text);
    if (slot) {
      // 课程名优先取蓝色 div；黑色字课程（暂无教学大纲、不可点击）回退取块首行
      const name = currentName || (pending.length ? pending[0] : '');
      if (!name) continue;
      out.push({ name, ...slot });
      currentName = null;
      pending = [];
      continue;
    }
    if (style.includes('rgb(0, 192, 239)') || style.includes('rgb(0,192,239)')) {
      currentName = text;
      pending = [];
    } else {
      pending.push(text);
    }
  }
  return out;
}

function parseUndergraduateScheduleFromDOM(doc) {
  const target = Array.from(doc.querySelectorAll('table'))
    .find(table => /\d+-\d+节\//.test(table.textContent || ''));
  if (!target) return [];

  const courseMap = new Map();
  const seen = new Set();
  for (const row of target.querySelectorAll('tr')) {
    const cells = Array.from(row.querySelectorAll('td, th'));
    for (let index = 1; index < cells.length; index++) {
      const weekday = index;
      const cell = cells[index];
      const raw = (cell.textContent || '').trim();
      if (!raw) continue;
      const key = weekday + '|' + raw.replace(/\s+/g, '');
      if (seen.has(key)) continue;
      seen.add(key);

      for (const item of parseUndergraduateCell(cell)) {
        if (!courseMap.has(item.name)) courseMap.set(item.name, []);
        const { name, ...slot } = item;
        slot.weekday = weekday;
        courseMap.get(item.name).push(slot);
      }
    }
  }
  return Array.from(courseMap, ([name, slots]) => ({ name, slots }));
}

// ===== 研究生教育信息系统 =====

function parseGraduateWeeks(text) {
  let raw = String(text || '').replace(/\s+/g, '');
  if (!/\d/.test(raw) || !raw.includes('周')) return null;

  const oddWeeksOnly = raw.includes('单');
  const evenWeeksOnly = raw.includes('双');
  if (oddWeeksOnly && evenWeeksOnly) return null;

  // 去掉“研”“第”“周”“单/双”等说明，仅保留数字、区间和分隔符。
  raw = raw.slice(raw.search(/\d/))
    .replace(/第/g, '')
    .replace(/周/g, '')
    .replace(/[单双]/g, '')
    .replace(/[\[\]【】()（）{}]/g, '')
    .replace(/[–—－~～至]/g, '-')
    .replace(/[，、;；/]/g, ',');

  const tokens = raw.split(',').filter(Boolean);
  if (!tokens.length) return null;

  const weekSet = new Set();
  for (const token of tokens) {
    let start;
    let end;
    const range = token.match(/^(\d+)-(\d+)$/);
    const single = token.match(/^\d+$/);
    if (range) {
      start = Number(range[1]);
      end = Number(range[2]);
    } else if (single) {
      start = Number(token);
      end = start;
    } else {
      return null;
    }
    if (start < 1 || end < start || end > 60) return null;
    for (let week = start; week <= end; week++) weekSet.add(week);
  }

  let weeks = Array.from(weekSet).sort((a, b) => a - b);
  if (oddWeeksOnly) weeks = weeks.filter(week => week % 2 === 1);
  if (evenWeeksOnly) weeks = weeks.filter(week => week % 2 === 0);
  if (!weeks.length) return null;

  return {
    weeks,
    startWeek: weeks[0],
    endWeek: weeks[weeks.length - 1],
    weekFlag: oddWeeksOnly ? '单周' : (evenWeeksOnly ? '双周' : ''),
    oddWeeksOnly,
    evenWeeksOnly,
  };
}

function graduateCourseNamesByCode(doc) {
  const names = new Map();
  const table = Array.from(doc.querySelectorAll('table')).find(candidate => {
    const text = candidate.textContent || '';
    return text.includes('课程代码') && text.includes('课程名称');
  });
  if (!table) return names;

  const rows = Array.from(table.rows || []);
  const header = rows.find(row => (row.textContent || '').includes('课程代码'));
  if (!header) return names;
  const labels = Array.from(header.cells).map(cell => (cell.textContent || '').trim());
  const codeIndex = labels.indexOf('课程代码');
  const nameIndex = labels.indexOf('课程名称');
  if (codeIndex < 0 || nameIndex < 0) return names;

  for (const row of rows) {
    const cells = Array.from(row.cells || []);
    if (cells.length <= Math.max(codeIndex, nameIndex)) continue;
    const code = (cells[codeIndex].textContent || '').trim();
    const name = (cells[nameIndex].textContent || '').trim();
    if (code && code !== '课程代码' && name) names.set(code, name);
  }
  return names;
}

function graduateSectionEndTimes(table) {
  const endTimes = new Map();
  for (const row of Array.from(table.rows || [])) {
    const cells = Array.from(row.cells || []);
    if (cells.length < 2) continue;
    const sectionMatch = (cells[0].textContent || '').match(/第\s*(\d+)\s*节/);
    const timeMatch = (cells[1].textContent || '').match(/\d{2}:\d{2}\s*[~～-]\s*(\d{2}:\d{2})/);
    if (sectionMatch && timeMatch) endTimes.set(Number(sectionMatch[1]), timeMatch[1]);
  }
  return endTimes;
}

function fallbackGraduateCourseName(courseLine) {
  const rest = courseLine.replace(/^[^-]+-/, '').trim();
  return rest.replace(/[（(][^（）()]*[）)]\s*$/, '').trim() || rest;
}

function parseGraduateScheduleFromDOM(doc) {
  const table = doc.querySelector('#jsTbl_01') ||
    Array.from(doc.querySelectorAll('table'))
      .find(candidate => candidate.querySelector('td[xq][jc] .kb_item'));
  if (!table) return [];

  const nameMap = graduateCourseNamesByCode(doc);
  const endTimes = graduateSectionEndTimes(table);
  const courseMap = new Map();
  const seen = new Set();

  for (const cell of table.querySelectorAll('td[xq][jc]')) {
    if (cell.style.display === 'none') continue;
    const weekday = Number(cell.getAttribute('xq'));
    const startSection = Number(cell.getAttribute('jc'));
    const span = Number(cell.getAttribute('rowspan') || '1');
    const endSection = startSection + Math.max(span, 1) - 1;
    if (!weekday || !startSection) continue;

    for (const card of cell.querySelectorAll('.arrage.kb_item')) {
      const lines = Array.from(card.children)
        .map(item => (item.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const weekLine = lines.find(line => /\d/.test(line) && line.includes('周'));
      const weekInfo = parseGraduateWeeks(weekLine);
      const courseLineIndex = lines.findIndex(line => /^[A-Za-z0-9]+-/.test(line));
      if (!weekInfo || courseLineIndex < 0) continue;

      const courseLine = lines[courseLineIndex];
      const codeMatch = courseLine.match(/^([A-Za-z0-9]+)-/);
      const code = codeMatch ? codeMatch[1] : '';
      const name = nameMap.get(code) || fallbackGraduateCourseName(courseLine);
      const location = lines[courseLineIndex + 2] || '';
      const { weeks, startWeek, endWeek, weekFlag, oddWeeksOnly, evenWeeksOnly } = weekInfo;
      const weekKey = weeks.join(',');
      const key = [name, weekday, startSection, endSection, weekKey, location].join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      const slot = {
        weekday,
        startSection,
        endSection,
        startWeek,
        endWeek,
        weekFlag,
        weeks,
        location,
      };
      const endTime = endTimes.get(endSection);
      if (endTime) slot.endTime = endTime;
      if (oddWeeksOnly) slot.oddWeeksOnly = true;
      if (evenWeeksOnly) slot.evenWeeksOnly = true;

      if (!courseMap.has(name)) courseMap.set(name, []);
      const slots = courseMap.get(name);
      const adjacent = slots.find(existing =>
        existing.weekday === slot.weekday &&
        Array.isArray(existing.weeks) &&
        existing.weeks.join(',') === weekKey &&
        existing.location === slot.location &&
        slot.startSection <= existing.endSection + 1 &&
        slot.endSection >= existing.startSection - 1
      );
      if (adjacent) {
        adjacent.startSection = Math.min(adjacent.startSection, slot.startSection);
        adjacent.endSection = Math.max(adjacent.endSection, slot.endSection);
        const mergedEndTime = endTimes.get(adjacent.endSection);
        if (mergedEndTime) adjacent.endTime = mergedEndTime;
      } else {
        slots.push(slot);
      }
    }
  }

  return Array.from(courseMap, ([name, slots]) => ({ name, slots }));
}

function normalizeGraduateSemester(text) {
  const raw = (text || '').replace(/\s+/g, ' ').trim();
  const match = raw.match(/(20\d{2}-20\d{2})学年\s*第([一二])学期/);
  if (!match) return raw;
  return `${match[1]}学年${match[2] === '一' ? '秋季' : '春季'}学期`;
}

// ===== 统一入口 =====

function pageType() {
  if (
    location.hostname === 'jw.ruc.edu.cn' &&
    window.top === window &&
    location.hash.endsWith('/student/student-course-list/')
  ) return 'undergraduate';

  if (
    location.hostname === 'yjs2.ruc.edu.cn' &&
    location.pathname.includes('/wdkbapp/') &&
    location.hash.includes('/xskcb')
  ) return 'graduate';

  return '';
}

function extractCourses() {
  const type = pageType();
  let courses = [];
  let semester = '';

  if (type === 'undergraduate') {
    courses = parseUndergraduateScheduleFromDOM(document);
    for (const input of document.querySelectorAll('input')) {
      if ((input.value || '').includes('学年')) {
        semester = input.value.trim();
        break;
      }
    }
  } else if (type === 'graduate') {
    courses = parseGraduateScheduleFromDOM(document);
    const semesterSelect = document.querySelector('#query_xnxq');
    semester = normalizeGraduateSemester(
      semesterSelect && semesterSelect.selectedOptions.length
        ? semesterSelect.selectedOptions[0].textContent
        : ''
    );
  }

  return { courses, semester, source: type, url: location.href, title: document.title };
}

function parseScheduleFromDOM() {
  const type = pageType();
  if (type === 'undergraduate') return parseUndergraduateScheduleFromDOM(document);
  if (type === 'graduate') return parseGraduateScheduleFromDOM(document);
  return [];
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'RUC_EXTRACT') {
      if (!pageType()) return false;
      try {
        sendResponse({ ok: true, ...extractCourses() });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    }
    return false;
  });
}

if (typeof globalThis !== 'undefined') {
  globalThis.RUC_CONTENT = {
    extractCourses,
    parseScheduleFromDOM,
    parseUndergraduateScheduleCell,
    parseUndergraduateScheduleFromDOM,
    parseGraduateScheduleFromDOM,
    parseGraduateWeeks,
    normalizeGraduateSemester,
  };
}
