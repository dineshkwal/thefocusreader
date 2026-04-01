// ── State ──
const state = {
  mode: 'sentence',
  playing: false,
  currentIndex: 0,
  units: [],
  paragraphs: [],
  fontSize: 1,
  speed: 56,
  timer: null,
  documentId: null,
  documentTitle: '',
  rawText: '',
  totalPages: 0,
  chapters: [],
};

// ── DOM refs ──
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const welcomeScreen = $('#welcomeScreen');
const reader = $('#reader');
const readerContent = $('#readerContent');
const bottomBar = $('#bottomBar');
const progressFill = $('#progressFill');
const progressText = $('#progressText');
const speedSlider = $('#speedSlider');
const speedLabel = $('#speedLabel');
const playPauseBtn = $('#playPauseBtn');
const dropZone = $('#actOpenPdf');
const fileInput = $('#fileInput');
const pasteText = $('#pasteText');
const loadingSpinner = $('#loadingSpinner');
const helpOverlay = $('#helpOverlay');

// ── PDF.js setup ──
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ── Load settings from localStorage ──
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('thefocusreader_settings') || '{}');
    if (s.theme) document.documentElement.dataset.theme = s.theme;
    if (s.mode) state.mode = s.mode;
    if (s.fontSize) state.fontSize = s.fontSize;
    if (s.speed) { state.speed = s.speed; speedSlider.value = s.speed; }
    if (s.font) { $('#fontSelect').value = s.font; setFont(s.font); }
    if (s.readingWidth) {
      $$('#widthGroup .btn').forEach(b => b.classList.toggle('active', b.dataset.width === s.readingWidth));
      readerContent.style.maxWidth = widthMap[s.readingWidth] || '65ch';
    }
    updateModeButtons();
    updateSpeedLabel();
    applyFontSize();
  } catch(e) {}
}

function saveSettings() {
  try {
    localStorage.setItem('thefocusreader_settings', JSON.stringify({
      theme: document.documentElement.dataset.theme,
      mode: state.mode,
      fontSize: state.fontSize,
      speed: state.speed,
      font: $('#fontSelect').value,
    }));
  } catch(e) {}
}

// ── Speed calculation ──
function getInterval() {
  const v = parseInt(speedSlider.value);
  if (state.mode === 'line') {
    return 5000 - (v / 100) * 4700;
  } else if (state.mode === 'sentence') {
    return 8000 - (v / 100) * 7200;
  } else {
    return 15000 - (v / 100) * 13500;
  }
}

// Adjust interval based on word count of current unit
// Scale interval by character count (excluding spaces) — most accurate proxy for reading time
function getAdjustedInterval() {
  const base = getInterval();
  const current = state.units[state.currentIndex];
  if (!current) return base;
  const text = current.textContent || '';
  const charCount = text.replace(/\s/g, '').length;
  // Baselines in characters (no spaces): sentence ~50, line ~40, paragraph ~200
  const baseline = state.mode === 'paragraph' ? 200 : state.mode === 'sentence' ? 50 : 40;
  const scale = Math.max(0.35, charCount / baseline);
  return base * scale;
}

function updateSpeedLabel() {
  const v = parseInt(speedSlider.value);
  if (state.mode === 'line') {
    const spl = (5 - (v / 100) * 4.7).toFixed(1);
    speedLabel.textContent = spl + ' s/line';
  } else if (state.mode === 'sentence') {
    const sps = (8 - (v / 100) * 7.2).toFixed(1);
    speedLabel.textContent = sps + ' s/sent';
  } else {
    const spp = (15 - (v / 100) * 13.5).toFixed(1);
    speedLabel.textContent = spp + ' s/para';
  }
}

// ── PDF Parsing (Enhanced) ──
const PAGE_BREAK = '\n\n<!--PAGEBREAK-->\n\n';

async function parsePDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  state.totalPages = pdf.numPages;

  // Extract PDF metadata for real book title
  try {
    const metadata = await pdf.getMetadata();
    console.log('PDF metadata:', JSON.stringify(metadata?.info));
    const pdfTitle = metadata?.info?.Title;
    if (pdfTitle && pdfTitle.trim().length > 2) {
      state.documentTitle = pdfTitle.trim();
      console.log('Title from metadata:', state.documentTitle);
    }
  } catch(e) { console.log('Metadata error:', e); }

  let fullText = '';
  let firstPageItems = null;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Save first few pages' items for title detection
    if (i <= 3 && !firstPageItems && content.items.length > 0) {
      const hasSubstantialText = content.items.some(item => item.str.trim().length > 3);
      if (hasSubstantialText) firstPageItems = { items: content.items, page: i };
    }
    const pageText = extractPageText(content, page);
    fullText += pageText;
    if (i < pdf.numPages) fullText += PAGE_BREAK;
  }

  // Smart title detection: find largest text on first substantial page
  if (!state.documentTitle && firstPageItems) {
    try {
      const items = firstPageItems.items.filter(item => item.str.trim().length > 1);
      if (items.length > 0) {
        // Group items by font size, find the largest
        const sizeGroups = {};
        items.forEach(item => {
          const size = Math.round(item.transform ? item.transform[0] : (item.height || 12));
          if (!sizeGroups[size]) sizeGroups[size] = [];
          sizeGroups[size].push(item.str.trim());
        });
        const maxSize = Math.max(...Object.keys(sizeGroups).map(Number));
        const titleParts = sizeGroups[maxSize];
        if (titleParts && titleParts.length > 0) {
          const candidate = titleParts.join(' ').replace(/\s+/g, ' ').trim();
          // Only use if it looks like a real title (3-100 chars, not all caps numbers/symbols)
          if (candidate.length >= 3 && candidate.length <= 100 && /[a-zA-Z]/.test(candidate)) {
            state.documentTitle = candidate;
          }
        }
      }
    } catch(e) {}
  }

  return fullText;
}

function extractPageText(content, page) {
  const items = content.items.filter(item => item.str.trim().length > 0);
  if (items.length === 0) return '';

  // ── Step 1: Enrich items with position and font info ──
  const enriched = items.map(item => {
    const tx = item.transform;
    return {
      str: item.str,
      x: tx[4],                           // horizontal position
      y: tx[5],                           // vertical position (PDF y = bottom-up)
      fontSize: Math.abs(tx[0]) || Math.abs(tx[3]) || 12, // font size from transform matrix
      fontName: item.fontName || '',
      width: item.width || 0,
      height: item.height || 0,
    };
  });

  // ── Step 2: Detect dominant (body) font size ──
  const fontSizeCounts = {};
  enriched.forEach(item => {
    const fs = Math.round(item.fontSize * 10) / 10; // round to 1 decimal
    const charLen = item.str.replace(/\s/g, '').length;
    fontSizeCounts[fs] = (fontSizeCounts[fs] || 0) + charLen;
  });
  const bodyFontSize = parseFloat(
    Object.entries(fontSizeCounts).sort((a, b) => b[1] - a[1])[0][0]
  );

  // ── Step 3: Detect dominant left margin (x position) for body text ──
  const xPositions = {};
  enriched.forEach(item => {
    if (Math.abs(item.fontSize - bodyFontSize) < 1) {
      const xRound = Math.round(item.x);
      xPositions[xRound] = (xPositions[xRound] || 0) + 1;
    }
  });
  const bodyLeftX = parseFloat(
    Object.entries(xPositions).sort((a, b) => b[1] - a[1])[0]?.[0] || 0
  );

  // ── Step 4: Detect if page has multiple columns ──
  const xValues = enriched
    .filter(item => Math.abs(item.fontSize - bodyFontSize) < 1)
    .map(item => item.x);
  const pageWidth = page.view ? (page.view[2] - page.view[0]) : 612;
  const midX = pageWidth / 2;
  const leftCol = xValues.filter(x => x < midX - 50);
  const rightCol = xValues.filter(x => x > midX + 50);
  const isMultiColumn = leftCol.length > 10 && rightCol.length > 10;

  // ── Step 5: Sort items into reading order ──
  let sorted;
  if (isMultiColumn) {
    // Split into columns, process left first then right
    const leftItems = enriched.filter(item => item.x < midX);
    const rightItems = enriched.filter(item => item.x >= midX);
    // Sort each column top-to-bottom, then left-to-right within lines
    const sortCol = (items) => items.sort((a, b) => {
      const yDiff = b.y - a.y; // PDF y is bottom-up, so higher y = earlier
      if (Math.abs(yDiff) > 2) return yDiff > 0 ? -1 : 1;
      return a.x - b.x;
    });
    sorted = [...sortCol(leftItems), ...sortCol(rightItems)];
  } else {
    sorted = enriched.sort((a, b) => {
      const yDiff = b.y - a.y;
      if (Math.abs(yDiff) > 2) return yDiff > 0 ? -1 : 1;
      return a.x - b.x;
    });
  }

  // ── Step 6: Group into lines and paragraphs ──
  const lines = [];
  let currentLine = { items: [sorted[0]], y: sorted[0].y };

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const yDiff = Math.abs(item.y - currentLine.y);

    if (yDiff < 3) {
      // Same line — append
      currentLine.items.push(item);
    } else {
      // New line
      lines.push(currentLine);
      currentLine = { items: [item], y: item.y };
    }
  }
  lines.push(currentLine);

  // ── Step 7: Build text with smart paragraph detection ──
  const result = [];
  let prevLine = null;
  let prevLineY = null;
  const lineHeights = [];

  // Calculate typical line height
  for (let i = 1; i < lines.length; i++) {
    const gap = Math.abs(lines[i - 1].y - lines[i].y);
    if (gap > 0 && gap < 50) lineHeights.push(gap);
  }
  lineHeights.sort((a, b) => a - b);
  const typicalLineHeight = lineHeights.length > 0
    ? lineHeights[Math.floor(lineHeights.length / 2)]
    : 14;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineText = line.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!lineText) continue;

    const lineFontSize = line.items[0].fontSize;
    const lineX = line.items[0].x;
    const isHeading = lineFontSize > bodyFontSize * 1.15;
    const isBold = line.items[0].fontName.toLowerCase().includes('bold');
    const isIndented = lineX > bodyLeftX + 10;

    // Determine if this is a new paragraph
    let newParagraph = false;
    if (prevLineY !== null) {
      const gap = Math.abs(prevLineY - line.y);
      // New paragraph if: gap > 1.5x typical line height, or heading, or significant indent change
      if (gap > typicalLineHeight * 1.5) newParagraph = true;
      if (isHeading) newParagraph = true;
    } else {
      newParagraph = true;
    }

    if (newParagraph && result.length > 0) {
      result.push('\n\n');
    } else if (result.length > 0) {
      // Same paragraph, add space (joining wrapped lines)
      const lastChar = result[result.length - 1].slice(-1);
      // If previous line ended with a hyphen, join without space (hyphenation)
      if (lastChar === '-') {
        result[result.length - 1] = result[result.length - 1].slice(0, -1);
      } else {
        result.push(' ');
      }
    }

    result.push(lineText);
    prevLineY = line.y;
    prevLine = line;
  }

  return result.join('');
}

// ── Text Processing ──
function processText(rawText) {
  state.rawText = rawText;
  if (!state.documentId) {
    state.documentId = hashText(rawText);
  }
  if (!state.documentTitle) {
    state.documentTitle = rawText.substring(0, 60).replace(/\s+/g, ' ').trim() + '...';
  }

  const pages = rawText.split(PAGE_BREAK);
  if (pages.length > 1) {
    state.totalPages = pages.length;
  } else if (!state.totalPages) {
    state.totalPages = 0;
  }

  state.paragraphs = [];
  pages.forEach((pageText, pageIdx) => {
    const rawParas = pageText.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(p => p.length > 0);
    rawParas.forEach(p => {
      const sentences = p.match(/[^.!?]*[.!?]+[\s]?|[^.!?]+$/g) || [p];
      state.paragraphs.push({
        text: p,
        sentences: sentences.map(s => s.trim()).filter(s => s.length > 0),
        page: pageIdx + 1,
      });
    });
  });

  renderText();
}

// ── Rendering ──
function renderText() {
  readerContent.innerHTML = '';
  // Dismiss any open dictionary card
  const existingDict = reader.querySelector('.dict-card');
  if (existingDict) existingDict.remove();
  let lastPage = 0;

  state.paragraphs.forEach((para, pi) => {
    if (para.page && para.page !== lastPage) {
      const marker = document.createElement('div');
      marker.className = 'page-marker';
      marker.dataset.page = para.page;
      marker.id = 'page-' + para.page;
      marker.textContent = 'Page ' + para.page;
      readerContent.appendChild(marker);
      lastPage = para.page;
    }

    const paraEl = document.createElement('div');
    paraEl.className = 'para';
    paraEl.dataset.paraIndex = pi;
    paraEl.dataset.page = para.page || 1;

    para.sentences.forEach((sent, si) => {
      const sentEl = document.createElement('span');
      sentEl.className = 'sentence';
      sentEl.dataset.paraIndex = pi;
      sentEl.dataset.sentIndex = si;
      sentEl.dataset.page = para.page || 1;

      const words = sent.split(/(\s+)/);
      words.forEach(w => {
        if (w.trim().length === 0) {
          sentEl.appendChild(document.createTextNode(w));
        } else {
          const wordEl = document.createElement('span');
          wordEl.className = 'word';
          wordEl.dataset.paraIndex = pi;
          wordEl.dataset.sentIndex = si;
          wordEl.dataset.page = para.page || 1;
          wordEl.textContent = w;
          sentEl.appendChild(wordEl);
        }
      });

      paraEl.appendChild(sentEl);
      if (si < para.sentences.length - 1) {
        paraEl.appendChild(document.createTextNode(' '));
      }
    });

    readerContent.appendChild(paraEl);
  });

  collectUnits();
  showReader();
  updatePageIndicator();
  if (state.mode === 'line') {
    generateLines();
    collectUnits();
  }
}

function collectUnits() {
  if (state.mode === 'line') {
    state.units = Array.from(readerContent.querySelectorAll('.line'));
  } else if (state.mode === 'sentence') {
    state.units = Array.from(readerContent.querySelectorAll('.sentence'));
  } else {
    state.units = Array.from(readerContent.querySelectorAll('.para'));
  }
  state.currentIndex = 0;
  updateFocus();
  updateProgress();
}

// ── Line Generation ──
function generateLines() {
  const paras = readerContent.querySelectorAll('.para');
  paras.forEach(paraEl => {
    const pi = paraEl.dataset.paraIndex;
    const page = paraEl.dataset.page;
    const text = paraEl.textContent;
    const words = text.split(/\s+/).filter(w => w.length > 0);

    const style = getComputedStyle(readerContent);
    const font = style.fontFamily;
    const fontSize = style.fontSize;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = fontSize + ' ' + font;
    const maxWidth = paraEl.clientWidth;

    const lines = [];
    let currentLine = '';
    words.forEach(word => {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      const width = ctx.measureText(testLine).width;
      if (width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    });
    if (currentLine) lines.push(currentLine);

    paraEl.innerHTML = '';
    lines.forEach(lineText => {
      const lineEl = document.createElement('span');
      lineEl.className = 'line';
      lineEl.dataset.paraIndex = pi;
      lineEl.dataset.page = page;
      lineEl.textContent = lineText;
      paraEl.appendChild(lineEl);
    });
  });
}

// ── Focus Management ──
function updateFocus() {
  const allParas = readerContent.querySelectorAll('.para');
  const allSents = readerContent.querySelectorAll('.sentence');
  const allLines = readerContent.querySelectorAll('.line');

  allParas.forEach(el => { el.classList.remove('focused', 'faded'); });
  allSents.forEach(el => { el.classList.remove('focused', 'faded'); });
  allLines.forEach(el => { el.classList.remove('focused', 'faded'); });

  if (state.units.length === 0) return;
  const current = state.units[state.currentIndex];
  if (!current) return;

  if (state.mode === 'paragraph') {
    allParas.forEach(el => el.classList.add('faded'));
    current.classList.remove('faded');
    current.classList.add('focused');
  } else if (state.mode === 'sentence') {
    allSents.forEach(el => el.classList.add('faded'));
    current.classList.remove('faded');
    current.classList.add('focused');
  } else if (state.mode === 'line') {
    allLines.forEach(el => el.classList.add('faded'));
    current.classList.remove('faded');
    current.classList.add('focused');
  }

  scrollToUnit(current);
}

function scrollToUnit(el) {
  const container = reader;
  const rect = el.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  let visibleBottom = containerRect.bottom;

  // Account for anything covering the bottom: settings sheet, tour tooltip, pause sheet
  if (mobileUI.isMobile()) {
    const obstructions = ['#mobilePauseSheet', '#tourTooltip'].map(s => $(s)).filter(Boolean);
    obstructions.forEach(obs => {
      const r = obs.getBoundingClientRect();
      if (r.top > 0 && r.top < visibleBottom && r.height > 20) {
        visibleBottom = Math.min(visibleBottom, r.top);
      }
    });
  }

  const visibleHeight = visibleBottom - containerRect.top;
  const centerY = containerRect.top + visibleHeight / 2;
  const elCenterY = rect.top + rect.height / 2;
  const diff = elCenterY - centerY;
  if (Math.abs(diff) > visibleHeight * 0.25) {
    container.scrollBy({ top: diff, behavior: 'smooth' });
  }
}

// ── Playback ──
function play() {
  if (state.units.length === 0) return;
  state.playing = true;
  playPauseBtn.innerHTML = '&#9646;&#9646;';
  advance();
  mobileUI.setState('playing');
  // Auto-hide bottom bar after delay (desktop)
  if (!mobileUI.isMobile() && typeof bottomBarTimer !== 'undefined') {
    clearTimeout(bottomBarTimer);
    bottomBarTimer = setTimeout(() => { bottomBar.classList.remove('visible'); }, 2500);
  }
}

function pause() {
  state.playing = false;
  clearTimeout(state.timer);
  state.timer = null;
  playPauseBtn.innerHTML = '&#9654;';
  saveSession();
  mobileUI.setState('paused');
  syncMobilePauseSheet();
  // Always show bar when paused (desktop)
  if (!mobileUI.isMobile()) {
    bottomBar.classList.add('visible');
    if (typeof bottomBarTimer !== 'undefined') clearTimeout(bottomBarTimer);
  }
}

function togglePlay() {
  if (state.playing) pause(); else play();
}

function advance() {
  if (!state.playing) return;
  const interval = getAdjustedInterval();
  state.timer = setTimeout(() => {
    if (state.currentIndex < state.units.length - 1) {
      state.currentIndex++;
      updateFocus();
      updateProgress();
      advance();
    } else {
      pause();
    }
  }, interval);
}

function goNext() {
  if (state.currentIndex < state.units.length - 1) {
    state.currentIndex++;
    updateFocus();
    updateProgress();
    if (state.playing) { clearTimeout(state.timer); advance(); }
  }
}

function goPrev() {
  if (state.currentIndex > 0) {
    state.currentIndex--;
    updateFocus();
    updateProgress();
    if (state.playing) { clearTimeout(state.timer); advance(); }
  }
}

function jumpTo(index) {
  state.currentIndex = Math.max(0, Math.min(index, state.units.length - 1));
  updateFocus();
  updateProgress();
  if (state.playing) { clearTimeout(state.timer); advance(); }
}

// ── Progress ──
function updateProgress() {
  if (state.units.length === 0) return;
  const pct = ((state.currentIndex + 1) / state.units.length) * 100;
  progressFill.style.width = pct + '%';
  progressText.textContent = Math.round(pct) + '%';
  // Update slim progress line
  const slimFill = $('#progressSlimFill');
  if (slimFill) slimFill.style.width = pct + '%';
  updatePageIndicator();
  updateActiveChapter();
  updateReadingTime();
}

// ── Page Indicator ──
function updatePageIndicator() {
  const nav = $('#pageNav');
  if (!nav || state.totalPages <= 0) { if (nav) nav.style.display = 'none'; return; }
  nav.style.display = '';
  $('#pageTotalLabel').textContent = '/ ' + state.totalPages;
  const current = state.units[state.currentIndex];
  if (current) { $('#pageInput').value = parseInt(current.dataset.page || '1'); }
}

function jumpToPage(pageNum) {
  pageNum = Math.max(1, Math.min(pageNum, state.totalPages));
  for (let i = 0; i < state.units.length; i++) {
    if (parseInt(state.units[i].dataset.page || '1') >= pageNum) { jumpTo(i); return; }
  }
}

// ── UI State ──
function showReader() {
  welcomeScreen.style.display = 'none';
  $('.app-body').classList.add('active');
  bottomBar.classList.add('active');
  $('#progressSlim').classList.add('active');
  $('#bottomHoverZone').classList.add('active');
  $$('.reader-only').forEach(el => el.style.display = '');
  $('#sidebarTitle').textContent = state.documentTitle;
  detectChapters();
  if (mobileUI.isMobile() && !state._skipMobileStateChange) {
    mobileUI.enter();
    $('#mobileDocTitle').textContent = state.documentTitle;
    // Delay to let units/chapters populate first
    setTimeout(() => {
      syncMobilePauseSheet();
      // Start onboarding tour for first-time users
      if (tour.shouldShow()) setTimeout(() => tour.start(), 1500);
    }, 100);
  } else {
    showBottomBar();
  }
}

function showWelcome() {
  saveSession();
  pause();
  mobileUI.exit();
  $('.app-body').classList.remove('active');
  bottomBar.classList.remove('active', 'visible');
  $('#progressSlim').classList.remove('active');
  $('#bottomHoverZone').classList.remove('active');
  $('#readingTimeInfo').style.display = 'none';
  welcomeScreen.style.display = '';
  readerContent.innerHTML = '';
  state.units = [];
  state.paragraphs = [];
  state.chapters = [];
  state.currentIndex = 0;
  state.documentId = null;
  state.documentTitle = '';
  state.isSample = false;
  state.rawText = '';
  state.totalPages = 0;
  $$('.reader-only').forEach(el => el.style.display = 'none');
  pasteText.value = '';
  // Reset paste area visibility
  $('#pasteArea').classList.remove('show');
  renderSavedSessions();
}

// ── Chapter Detection ──
function detectChapters() {
  state.chapters = [];
  const chapterPatterns = [
    /^chapter\s+\d+/i, /^part\s+\d+/i, /^ch\s*\.\s*\d+/i,
    /^chapter\s+\d+\s*[|:.\-]/i, /^section\s+\d+/i,
    /^DEDICATION$/i, /^CONTENTS$/i, /^INTRODUCTION$/i, /^PREFACE$/i,
    /^FOREWORD$/i, /^EPILOGUE$/i, /^APPENDIX/i, /^ACKNOWLEDGMENT/i, /^CONCLUSION$/i,
  ];

  state.paragraphs.forEach((para, pi) => {
    const text = para.text.trim();
    const isChapter = chapterPatterns.some(p => p.test(text));
    const isAllCapsHeading = text.length > 3 && text.length < 80 && text === text.toUpperCase() && /[A-Z]/.test(text);
    if (isChapter || isAllCapsHeading) {
      state.chapters.push({
        title: text.length > 50 ? text.substring(0, 50) + '...' : text,
        paraIndex: pi,
        page: para.page || 1,
      });
    }
  });
  renderSidebarChapters();
}

function renderSidebarChapters() {
  const container = $('#sidebarChapters');
  container.innerHTML = '';
  if (state.chapters.length === 0) {
    container.innerHTML = '<div class="no-chapters">No chapters detected.<br>Chapters are auto-detected from headings.</div>';
    return;
  }
  state.chapters.forEach((ch, idx) => {
    const item = document.createElement('div');
    item.className = 'chapter-item';
    item.dataset.chapterIdx = idx;
    item.innerHTML = `
      <span class="ch-num">${idx + 1}</span>
      <span class="ch-name" title="${escHtml(ch.title)}">${escHtml(ch.title)}</span>
      ${ch.page ? '<span class="ch-page">' + ch.page + '</span>' : ''}
    `;
    item.addEventListener('click', () => jumpToChapter(idx));
    container.appendChild(item);
  });
  updateActiveChapter();
}

function jumpToChapter(idx) {
  const ch = state.chapters[idx];
  if (!ch) return;
  for (let i = 0; i < state.units.length; i++) {
    if (parseInt(state.units[i].dataset.paraIndex || '0') >= ch.paraIndex) { jumpTo(i); break; }
  }
}

function updateActiveChapter() {
  if (state.chapters.length === 0) return;
  const currentPara = getCurrentParaIndex();
  let activeIdx = 0;
  for (let i = 0; i < state.chapters.length; i++) {
    if (state.chapters[i].paraIndex <= currentPara) activeIdx = i;
  }
  $$('.chapter-item').forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  const activeEl = $('.chapter-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const pct = state.units.length > 0 ? Math.round(((state.currentIndex + 1) / state.units.length) * 100) : 0;
  $('#sidebarPct').textContent = pct + '%';
  $('#sidebarProgressFill').style.width = pct + '%';
  if (state.totalPages > 0) {
    const current = state.units[state.currentIndex];
    const pg = current ? parseInt(current.dataset.page || '1') : 1;
    $('#sidebarPageInfo').textContent = 'Pg ' + pg + ' / ' + state.totalPages;
  }
}

function toggleSidebar() { $('#sidebar').classList.toggle('open'); }

// ── Reading Time Estimation ──
function updateReadingTime() {
  const info = $('#readingTimeInfo');
  if (state.units.length === 0) { info.style.display = 'none'; return; }
  info.style.display = '';

  const currentPara = getCurrentParaIndex();
  let charsRemaining = 0;
  let charsCurrChapterRemaining = 0;
  let totalChars = 0;
  let nextChapterPara = state.paragraphs.length;

  // Find current and next chapter boundaries
  let currentChapterName = '';
  if (state.chapters.length > 0) {
    let activeChIdx = 0;
    for (let i = 0; i < state.chapters.length; i++) {
      if (state.chapters[i].paraIndex <= currentPara) activeChIdx = i;
    }
    currentChapterName = state.chapters[activeChIdx].title;
    nextChapterPara = (activeChIdx + 1 < state.chapters.length)
      ? state.chapters[activeChIdx + 1].paraIndex
      : state.paragraphs.length;
  }

  state.paragraphs.forEach((para, pi) => {
    const chars = para.text.replace(/\s/g, '').length;
    totalChars += chars;
    if (pi > currentPara) {
      charsRemaining += chars;
      if (pi < nextChapterPara) charsCurrChapterRemaining += chars;
    }
  });

  const cpm = 1000;
  const bookMinsLeft = Math.ceil(charsRemaining / cpm);
  const chapterMinsLeft = Math.ceil(charsCurrChapterRemaining / cpm);

  if (state.chapters.length > 0) {
    $('#rtChapter').textContent = currentChapterName;
    $('#rtTime').innerHTML = '<span class="rt-label">Chapter:</span> ' + formatTime(chapterMinsLeft) + ' left &nbsp;<span class="rt-sep">|</span>&nbsp; <span class="rt-label">Book:</span> ' + formatTime(bookMinsLeft) + ' left';
  } else {
    $('#rtChapter').textContent = state.documentTitle || '';
    $('#rtTime').textContent = formatTime(bookMinsLeft) + ' left';
  }
}

function formatTime(mins) {
  if (mins < 1) return '< 1 min';
  if (mins < 60) return mins + ' min';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h + 'h ' + (m > 0 ? m + 'm' : '');
}

function setMode(mode) {
  const wasPlaying = state.playing;
  const preserveMobileState = mobileUI.isMobile() ? mobileUI.state : null;

  // Stop playback without triggering mobile state change
  if (wasPlaying) {
    state.playing = false;
    clearTimeout(state.timer);
    state.timer = null;
    playPauseBtn.innerHTML = '&#9654;';
  }

  const oldMode = state.mode;
  const currentUnit = state.units[state.currentIndex];
  let targetParaIndex = 0;
  if (currentUnit) targetParaIndex = parseInt(currentUnit.dataset.paraIndex || '0');

  state.mode = mode;
  updateModeButtons();
  updateSpeedLabel();

  // Block showReader from changing mobile state during mode switch
  state._skipMobileStateChange = true;

  if (mode === 'line' || oldMode === 'line') {
    renderText();
  } else {
    collectUnits();
  }

  state._skipMobileStateChange = false;

  if (state.units.length > 0) {
    let bestIdx = 0;
    for (let i = 0; i < state.units.length; i++) {
      if (parseInt(state.units[i].dataset.paraIndex || '0') >= targetParaIndex) { bestIdx = i; break; }
    }
    state.currentIndex = bestIdx;
    updateFocus();
    updateProgress();
  }

  // Resume playback without triggering mobile state change
  if (wasPlaying) {
    state.playing = true;
    playPauseBtn.innerHTML = '&#9646;&#9646;';
    advance();
  }

  // Restore mobile state
  if (preserveMobileState) mobileUI.setState(preserveMobileState);

  saveSettings();
}

function updateModeButtons() {
  $$('#modeGroup .btn').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
}

function setFont(font) {
  document.body.classList.remove('font-serif', 'font-sans', 'font-mono');
  document.body.classList.add('font-' + font);
}

function applyFontSize() { readerContent.style.fontSize = state.fontSize + 'rem'; }

function toggleTheme() {
  const html = document.documentElement;
  const themes = ['dark', 'light', 'sepia'];
  const current = themes.indexOf(html.dataset.theme);
  html.dataset.theme = themes[(current + 1) % 3];
  updateThemeIcon();
  saveSettings();
}

function updateThemeIcon() {
  const theme = document.documentElement.dataset.theme;
  const btn = $('#themeToggle');
  if (theme === 'dark') btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  else if (theme === 'light') btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  else btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{});
  else document.exitFullscreen();
  updateFullscreenIcon();
}

function updateFullscreenIcon() {
  const btn = $('#fullscreenBtn');
  if (!btn) return;
  if (document.fullscreenElement) {
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  } else {
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  }
}
document.addEventListener('fullscreenchange', updateFullscreenIcon);

function toggleHelp() { helpOverlay.classList.toggle('active'); }

// ── Document ID ──
function hashText(text) {
  let hash = 0;
  const sample = text.substring(0, 2000);
  for (let i = 0; i < sample.length; i++) {
    const ch = sample.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return 'doc_' + Math.abs(hash).toString(36);
}

// ── Session Persistence ──
function getSessions() {
  try { return JSON.parse(localStorage.getItem('thefocusreader_sessions') || '{}'); } catch(e) { return {}; }
}

function saveSession() {
  if (!state.documentId || state.paragraphs.length === 0 || state.isSample) return;
  const sessions = getSessions();
  sessions[state.documentId] = {
    title: state.documentTitle, paraIndex: getCurrentParaIndex(), mode: state.mode,
    currentIndex: state.currentIndex, totalUnits: state.units.length, rawText: state.rawText,
    lastRead: Date.now(), bookmarks: (sessions[state.documentId] && sessions[state.documentId].bookmarks) || [],
  };
  localStorage.setItem('thefocusreader_sessions', JSON.stringify(sessions));
}

function getCurrentParaIndex() {
  const current = state.units[state.currentIndex];
  return current ? parseInt(current.dataset.paraIndex || '0') : 0;
}

function deleteSession(docId) {
  const sessions = getSessions();
  delete sessions[docId];
  localStorage.setItem('thefocusreader_sessions', JSON.stringify(sessions));
  renderSavedSessions();
}

function resumeSession(docId) {
  const sessions = getSessions();
  const session = sessions[docId];
  if (!session || !session.rawText) return;
  state.rawText = session.rawText;
  state.documentId = docId;
  state.documentTitle = session.title;
  state.mode = session.mode || 'sentence';
  updateModeButtons();
  updateSpeedLabel();
  processText(session.rawText);
  const targetPara = session.paraIndex || 0;
  if (state.units.length > 0) {
    let bestIdx = 0;
    for (let i = 0; i < state.units.length; i++) {
      if (parseInt(state.units[i].dataset.paraIndex || '0') >= targetPara) { bestIdx = i; break; }
    }
    state.currentIndex = bestIdx;
    updateFocus();
    updateProgress();
  }
}

function renderSavedSessions() {
  const sessions = getSessions();
  const entries = Object.entries(sessions).sort((a, b) => (b[1].lastRead || 0) - (a[1].lastRead || 0));
  const container = $('#sessionList');
  const wrapper = $('#savedSessions');
  if (entries.length === 0) { wrapper.style.display = 'none'; return; }
  wrapper.style.display = '';
  container.innerHTML = '';
  entries.forEach(([docId, session]) => {
    const pct = session.totalUnits > 0 ? Math.round(((session.currentIndex || 0) + 1) / session.totalUnits * 100) : 0;
    const ago = timeAgo(session.lastRead);
    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="session-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>
      <div class="session-info">
        <div class="session-title">${escHtml(session.title)}</div>
        <div class="session-meta">${pct}% read &middot; ${ago}</div>
      </div>
      <div class="session-pct">${pct}%</div>
      <button class="session-delete" title="Remove">&times;</button>
    `;
    card.querySelector('.session-info').addEventListener('click', () => resumeSession(docId));
    card.querySelector('.session-icon').addEventListener('click', () => resumeSession(docId));
    card.querySelector('.session-delete').addEventListener('click', (e) => { e.stopPropagation(); deleteSession(docId); });
    container.appendChild(card);
  });
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

// ── Bookmarks ──
function getBookmarks() {
  if (!state.documentId) return [];
  const sessions = getSessions();
  return (sessions[state.documentId] && sessions[state.documentId].bookmarks) || [];
}

function addBookmark(name) {
  if (!state.documentId) return;
  const sessions = getSessions();
  if (!sessions[state.documentId]) return;
  const bm = {
    name: name || 'Bookmark ' + (getBookmarks().length + 1),
    paraIndex: getCurrentParaIndex(), mode: state.mode, unitIndex: state.currentIndex, created: Date.now(),
  };
  sessions[state.documentId].bookmarks = sessions[state.documentId].bookmarks || [];
  sessions[state.documentId].bookmarks.push(bm);
  localStorage.setItem('thefocusreader_sessions', JSON.stringify(sessions));
  showToast('Bookmark saved: ' + bm.name);
}

function deleteBookmark(idx) {
  const sessions = getSessions();
  if (!sessions[state.documentId]) return;
  sessions[state.documentId].bookmarks.splice(idx, 1);
  localStorage.setItem('thefocusreader_sessions', JSON.stringify(sessions));
  renderBookmarksList();
}

function jumpToBookmark(bm) {
  if (bm.mode && bm.mode !== state.mode) setMode(bm.mode);
  const targetPara = bm.paraIndex || 0;
  let bestIdx = 0;
  for (let i = 0; i < state.units.length; i++) {
    if (parseInt(state.units[i].dataset.paraIndex || '0') >= targetPara) { bestIdx = i; break; }
  }
  jumpTo(bestIdx);
  toggleBookmarks();
}

function renderBookmarksList() {
  const bookmarks = getBookmarks();
  const container = $('#bookmarksList');
  container.innerHTML = '';
  if (bookmarks.length === 0) {
    container.innerHTML = '<div class="no-bookmarks">No bookmarks yet. Press <b>B</b> while reading to add one.</div>';
    return;
  }
  bookmarks.forEach((bm, idx) => {
    const item = document.createElement('div');
    item.className = 'bookmark-item';
    item.innerHTML = `
      <span class="bookmark-icon">&#128278;</span>
      <div class="bookmark-details">
        <div class="bookmark-name">${escHtml(bm.name)}</div>
        <div class="bookmark-pos">Para ${bm.paraIndex + 1} &middot; ${bm.mode} mode &middot; ${timeAgo(bm.created)}</div>
      </div>
      <button class="bookmark-delete" title="Delete">&times;</button>
    `;
    item.querySelector('.bookmark-details').addEventListener('click', () => jumpToBookmark(bm));
    item.querySelector('.bookmark-icon').addEventListener('click', () => jumpToBookmark(bm));
    item.querySelector('.bookmark-delete').addEventListener('click', (e) => { e.stopPropagation(); deleteBookmark(idx); });
    container.appendChild(item);
  });
}

function toggleBookmarks() {
  const overlay = $('#bookmarksOverlay');
  overlay.classList.toggle('active');
  if (overlay.classList.contains('active')) renderBookmarksList();
}

function showToast(msg) {
  const toast = $('#bookmarkToast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

function promptBookmarkName() {
  const name = prompt('Bookmark name:', 'Bookmark ' + (getBookmarks().length + 1));
  if (name !== null) addBookmark(name.trim() || undefined);
}

// ── Click handlers ──
readerContent.addEventListener('click', (e) => {
  // On mobile, tap always pauses/resumes — no jump-to-unit
  if (mobileUI.isMobile()) return;
  let target = e.target;
  if (state.mode === 'line') target = target.closest('.line');
  else if (state.mode === 'sentence') target = target.closest('.sentence');
  else target = target.closest('.para');
  if (!target) return;
  const idx = state.units.indexOf(target);
  if (idx >= 0) jumpTo(idx);
});

// ── Event Listeners ──
$$('#modeGroup .btn').forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

speedSlider.addEventListener('input', () => {
  state.speed = parseInt(speedSlider.value);
  updateSpeedLabel();
  saveSettings();
  if (state.playing) { clearTimeout(state.timer); advance(); }
});


function stepSpeed(delta) {
  speedSlider.value = Math.max(1, Math.min(100, parseInt(speedSlider.value) + delta));
  state.speed = parseInt(speedSlider.value);
  updateSpeedLabel();
  saveSettings();
  if (state.playing) { clearTimeout(state.timer); advance(); }
}
$('#speedDown').addEventListener('click', () => stepSpeed(-1));
$('#speedUp').addEventListener('click', () => stepSpeed(1));

playPauseBtn.addEventListener('click', togglePlay);
$('#prevBtn').addEventListener('click', goPrev);
$('#nextBtn').addEventListener('click', goNext);

$('#progressBar').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  jumpTo(Math.round(pct * (state.units.length - 1)));
});

$('#fontUp').addEventListener('click', () => { state.fontSize = Math.min(2.5, state.fontSize + 0.1); applyFontSize(); updateFontSizeDisplay(); saveSettings(); });
$('#fontDown').addEventListener('click', () => { state.fontSize = Math.max(0.7, state.fontSize - 0.1); applyFontSize(); updateFontSizeDisplay(); saveSettings(); });
$('#fontSelect').addEventListener('change', (e) => { setFont(e.target.value); saveSettings(); });

// Width control
const widthMap = { narrow: '50ch', medium: '65ch', wide: '85ch', full: '100%' };
$$('#widthGroup .btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#widthGroup .btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const w = btn.dataset.width;
    readerContent.style.setProperty('--reading-width', widthMap[w]);
    readerContent.style.maxWidth = widthMap[w];
    try {
      const s = JSON.parse(localStorage.getItem('thefocusreader_settings') || '{}');
      s.readingWidth = w;
      localStorage.setItem('thefocusreader_settings', JSON.stringify(s));
    } catch(e) {}
  });
});

// Fullscreen header peek on hover
$('#headerHoverZone').addEventListener('mouseenter', () => {
  $('.header').classList.add('peek');
});
$('.header').addEventListener('mouseleave', () => {
  if (document.fullscreenElement) $('.header').classList.remove('peek');
});

// Settings tray toggle — handled in mobile UI section for both desktop & mobile
function updateFontSizeDisplay() {
  const el = $('#fontSizeDisplay');
  if (el) el.textContent = state.fontSize.toFixed(1);
}

$('#sidebarToggle').addEventListener('click', toggleSidebar);
$('#logoHome').addEventListener('click', () => {
  if ($('.app-body') && $('.app-body').classList.contains('active')) {
    if (mobileUI.isMobile()) mobileUI.exit();
    showWelcome();
  }
});
$('#themeToggle').addEventListener('click', toggleTheme);
$('#fullscreenBtn').addEventListener('click', () => { toggleFullscreen(); tour.onAction('fullscreen'); });
$('#helpBtn').addEventListener('click', toggleHelp);
$('#bookmarkBtn').addEventListener('click', toggleBookmarks);
$('#addBookmarkBtn').addEventListener('click', () => { promptBookmarkName(); renderBookmarksList(); });
$('#newTextBtn').addEventListener('click', showWelcome);
$('#bookmarksOverlay').addEventListener('click', (e) => { if (e.target === $('#bookmarksOverlay')) toggleBookmarks(); });

fileInput.addEventListener('change', async (e) => { const file = e.target.files[0]; if (file) await handleFile(file); });

$('#pageInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); const pg = parseInt(e.target.value); if (!isNaN(pg)) jumpToPage(pg); e.target.blur(); }
});
$('#pageInput').addEventListener('change', (e) => { const pg = parseInt(e.target.value); if (!isNaN(pg)) jumpToPage(pg); });

// (drag/drop handled in mobile UI section)

async function handleFile(file) {
  loadingSpinner.classList.add('active');
  try {
    let text;
    if (file.name.endsWith('.pdf')) text = await parsePDF(file);
    else text = await file.text();
    state.documentId = hashText(text);
    if (!state.documentTitle) state.documentTitle = file.name.replace(/\.[^.]+$/, '');
    processText(text);
  } catch (err) {
    alert('Error reading file: ' + err.message);
  } finally {
    loadingSpinner.classList.remove('active');
  }
}

$('#pasteBtn').addEventListener('click', () => { const text = pasteText.value.trim(); if (text.length > 0) processText(text); });

// ── Keyboard Shortcuts ──
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  switch(e.key) {
    case ' ': e.preventDefault(); if (state.units.length > 0) togglePlay(); break;
    case 'ArrowRight': e.preventDefault(); goNext(); break;
    case 'ArrowLeft': e.preventDefault(); goPrev(); break;
    case 'ArrowUp':
      e.preventDefault();
      speedSlider.value = Math.min(100, parseInt(speedSlider.value) + 5);
      state.speed = parseInt(speedSlider.value); updateSpeedLabel(); saveSettings();
      if (state.playing) { clearTimeout(state.timer); advance(); } break;
    case 'ArrowDown':
      e.preventDefault();
      speedSlider.value = Math.max(1, parseInt(speedSlider.value) - 5);
      state.speed = parseInt(speedSlider.value); updateSpeedLabel(); saveSettings();
      if (state.playing) { clearTimeout(state.timer); advance(); } break;
    case '1': setMode('line'); break;
    case '2': setMode('sentence'); break;
    case '3': setMode('paragraph'); break;
    case 'd': case 'D': toggleTheme(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case '=': case '+': state.fontSize = Math.min(2.5, state.fontSize + 0.1); applyFontSize(); saveSettings(); break;
    case '-': case '_': state.fontSize = Math.max(0.7, state.fontSize - 0.1); applyFontSize(); saveSettings(); break;
    case 'c': case 'C': toggleSidebar(); break;
    case 'b': case 'B': if (state.units.length > 0) promptBookmarkName(); break;
    case '?': toggleHelp(); break;
    case 'Escape':
      if ($('#bookmarksOverlay').classList.contains('active')) toggleBookmarks();
      else if (helpOverlay.classList.contains('active')) toggleHelp();
      else if ($('.app-body').classList.contains('active')) showWelcome();
      break;
  }
});

helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) toggleHelp(); });

// ── Bottom Bar Auto-Hide ──
let bottomBarTimer = null;

function showBottomBar() {
  bottomBar.classList.add('visible');
  clearTimeout(bottomBarTimer);
  bottomBarTimer = setTimeout(hideBottomBar, 2500);
}

function hideBottomBar() {
  // Don't hide if paused or hovering
  if (!state.playing) return;
  bottomBar.classList.remove('visible');
}

// Show on hover zone (desktop only)
$('#bottomHoverZone').addEventListener('mouseenter', () => { if (!mobileUI.isMobile()) showBottomBar(); });
// Keep visible while hovering the bar itself
bottomBar.addEventListener('mouseenter', () => { clearTimeout(bottomBarTimer); bottomBar.classList.add('visible'); });
bottomBar.addEventListener('mouseleave', () => { if (state.playing) bottomBarTimer = setTimeout(hideBottomBar, 1500); });

// Show on any mouse movement in reader, then auto-hide (desktop only)
document.addEventListener('mousemove', () => {
  if (mobileUI.isMobile()) return;
  if ($('.app-body') && $('.app-body').classList.contains('active')) {
    showBottomBar();
  }
});

// Always show when paused
const _origPause = pause;
// Override handled inline — pause already exists, so hook into it via updateProgress
// Instead, use a MutationObserver-free approach: check in showBottomBar

// ── Mobile UI ──
const mobileUI = {
  state: null,
  isMobile() { return window.matchMedia('(max-width: 768px)').matches; },
  setState(newState) {
    if (!this.isMobile()) return;
    document.body.classList.remove('mobile-playing', 'mobile-paused', 'mobile-settings');
    this.state = newState;
    if (newState) document.body.classList.add('mobile-' + newState);
    if (newState === 'settings') syncMobileSettingsUI();
  },
  enter() { this.setState('paused'); },
  exit() {
    this.state = null;
    document.body.classList.remove('mobile-playing', 'mobile-paused', 'mobile-settings');
  }
};

function syncMobileSettingsUI() {
  if (!mobileUI.isMobile()) return;
  // Speed — show interval with unit
  const sv = $('#mobileSpeedVal');
  if (sv) sv.textContent = parseFloat($('#speedLabel').textContent).toFixed(1) + 's';
  // Speed unit label
  const su = document.querySelector('.ms-speed-unit');
  if (su) {
    const modeLabels = { line: 'speed per line', sentence: 'speed per sentence', paragraph: 'speed per paragraph' };
    su.textContent = modeLabels[state.mode] || 'per unit';
  }
  // Mode
  $$('#mobileModeGroup .ms-pill').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === state.mode));
  // Theme icon + label
  const themeIcon = $('#mobileThemeIcon');
  const themeLabel = $('#mobileThemeLabel');
  if (themeIcon) {
    const theme = document.documentElement.dataset.theme;
    if (theme === 'dark') themeIcon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    else if (theme === 'light') themeIcon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/></svg>';
    else themeIcon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
    const labels = { dark: 'Dark', light: 'Light', sepia: 'Sepia' };
    if (themeLabel) themeLabel.textContent = labels[theme] || 'Dark';
  }
  // Font preview + label
  const fontIcon = $('#mobileFontIcon');
  const fontLabel = $('#mobileFontLabel');
  if (fontIcon) {
    const fonts = { serif: "'Newsreader',serif", sans: "'DM Sans',sans-serif", mono: "monospace" };
    const fontNames = { serif: 'Serif', sans: 'Sans', mono: 'Mono' };
    const currentFont = $('#fontSelect').value;
    fontIcon.style.fontFamily = fonts[currentFont] || fonts.serif;
    if (fontLabel) fontLabel.textContent = fontNames[currentFont] || 'Serif';
  }
  // Font size
  const fv = $('#mobileFontVal');
  if (fv) fv.textContent = state.fontSize.toFixed(1);
}

function syncMobilePauseSheet() {
  if (!mobileUI.isMobile()) return;
  // Progress
  const pct = state.units.length > 0 ? Math.round(((state.currentIndex + 1) / state.units.length) * 100) : 0;
  const fill = $('#mpsBarFill');
  if (fill) fill.style.width = pct + '%';
  const pctEl = $('#mpsPct');
  if (pctEl) pctEl.textContent = pct + '%';

  // Page
  const pageEl = $('#mpsPage');
  if (pageEl) {
    if (state.totalPages > 0) {
      const current = state.units[state.currentIndex];
      const pg = current ? parseInt(current.dataset.page || '1') : 1;
      pageEl.textContent = 'Page ' + pg + ' / ' + state.totalPages;
    } else {
      pageEl.textContent = '';
    }
  }

  // Chapter + time
  const chNameEl = $('#mpsChapterName');
  const timeEl = $('#mpsTime');
  if (!chNameEl || !timeEl) return;

  const currentPara = getCurrentParaIndex();
  let charsRemaining = 0, charsCurrChapterRemaining = 0;
  let nextChapterPara = state.paragraphs.length;
  let currentChapterName = '';

  if (state.chapters.length > 0) {
    let activeChIdx = 0;
    for (let i = 0; i < state.chapters.length; i++) {
      if (state.chapters[i].paraIndex <= currentPara) activeChIdx = i;
    }
    currentChapterName = state.chapters[activeChIdx].title;
    nextChapterPara = (activeChIdx + 1 < state.chapters.length)
      ? state.chapters[activeChIdx + 1].paraIndex : state.paragraphs.length;
  }

  state.paragraphs.forEach((para, pi) => {
    const chars = para.text.replace(/\s/g, '').length;
    if (pi > currentPara) {
      charsRemaining += chars;
      if (pi < nextChapterPara) charsCurrChapterRemaining += chars;
    }
  });

  const cpm = 1000;
  const bookMinsLeft = Math.ceil(charsRemaining / cpm);
  const chapterMinsLeft = Math.ceil(charsCurrChapterRemaining / cpm);

  if (state.chapters.length > 0) {
    chNameEl.textContent = currentChapterName;
    timeEl.innerHTML = '<span class="t-label">Chapter:</span> ' + formatTime(chapterMinsLeft) + ' left <span class="t-sep">|</span> <span class="t-label">Book:</span> ' + formatTime(bookMinsLeft) + ' left';
  } else {
    chNameEl.textContent = state.documentTitle || '';
    timeEl.textContent = formatTime(bookMinsLeft) + ' left';
  }
}

// Mobile: big play button
$('#mobilePlayBig').addEventListener('click', (e) => {
  e.stopPropagation();
  play();
  tour.onAction('tap-to-play');
});

// Mobile: pull-up/down sheet drag interaction
(function() {
  const sheet = $('#mobilePauseSheet');
  if (!sheet) return;
  let startY = 0, isDragging = false, startedOnInteractive = false;

  sheet.addEventListener('touchstart', (e) => {
    if (!mobileUI.isMobile()) return;
    if (mobileUI.state !== 'paused' && mobileUI.state !== 'settings') return;
    // Don't hijack touches on buttons/inputs inside the sheet
    const tag = e.target.tagName;
    startedOnInteractive = (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || e.target.closest('button, input, select'));
    if (startedOnInteractive) return;
    startY = e.touches[0].clientY;
    isDragging = true;
  }, { passive: true });

  sheet.addEventListener('touchend', (e) => {
    if (!isDragging || startedOnInteractive) { isDragging = false; return; }
    isDragging = false;
    const endY = e.changedTouches[0].clientY;
    const diff = startY - endY;

    if (diff > 30 && mobileUI.state === 'paused') {
      // Swiped up — expand to settings with live preview
      if (!state.playing && state.units.length > 0) {
        state.playing = true;
        playPauseBtn.innerHTML = '&#9646;&#9646;';
        advance();
      }
      mobileUI.setState('settings');
      syncMobileSettingsUI();
      tour.onAction('swipe-up');
    } else if (diff < -30 && mobileUI.state === 'settings') {
      // Swiped down — collapse back to paused
      pause();
      tour.onAction('swipe-down');
    }
  }, { passive: true });

  // Also allow tap on handle to toggle
  $('#mpsHandle').addEventListener('click', (e) => {
    if (!mobileUI.isMobile()) return;
    e.stopPropagation();
    if (mobileUI.state === 'paused') {
      if (!state.playing && state.units.length > 0) {
        state.playing = true;
        playPauseBtn.innerHTML = '&#9646;&#9646;';
        advance();
      }
      mobileUI.setState('settings');
      syncMobileSettingsUI();
    } else if (mobileUI.state === 'settings') {
      pause();
      tour.onAction('swipe-down');
    }
  });
})();

// Mobile: tap reader to pause/play (any tap on reader area)
reader.addEventListener('click', (e) => {
  if (!mobileUI.isMobile()) return;
  if (!$('.app-body').classList.contains('active')) return;
  if (mobileUI.state === 'playing') { pause(); tour.onAction('tap-to-pause'); }
  else if (mobileUI.state === 'paused') { play(); tour.onAction('tap-to-play'); }
});

// Mobile: backdrop tap
$('#mobileBackdrop').addEventListener('click', () => {
  if (mobileUI.state === 'settings') { pause(); }
  else if (mobileUI.state === 'paused') play();
});

// Settings gear: mobile opens settings panel, desktop toggles tray
$('#settingsGear').addEventListener('click', () => {
  if (mobileUI.isMobile()) {
    if (mobileUI.state === 'settings') {
      mobileUI.setState('paused');
    } else {
      // Resume playing so user sees live preview
      if (!state.playing && state.units.length > 0) {
        state.playing = true;
        playPauseBtn.innerHTML = '&#9646;&#9646;';
        advance();
      }
      mobileUI.setState('settings');
      syncMobileSettingsUI();
    }
  } else {
    $('#settingsTray').classList.toggle('open');
    $('#settingsGear').classList.toggle('active');
  }
});
// Mobile: close button (back to welcome)
$('#mobileCloseBtn').addEventListener('click', () => { mobileUI.exit(); showWelcome(); });

// Action rows: Open PDF (file input is inside the row, handles itself via change event)
// Drag and drop on the Open PDF row
$('#actOpenPdf').addEventListener('dragover', (e) => { e.preventDefault(); $('#actOpenPdf').style.borderColor = 'var(--accent)'; });
$('#actOpenPdf').addEventListener('dragleave', () => { $('#actOpenPdf').style.borderColor = ''; });
$('#actOpenPdf').addEventListener('drop', async (e) => { e.preventDefault(); $('#actOpenPdf').style.borderColor = ''; const file = e.dataTransfer.files[0]; if (file) await handleFile(file); });

// Action rows: Paste text
$('#actPasteText').addEventListener('click', () => {
  const pa = $('#pasteArea');
  pa.classList.toggle('show');
  if (pa.classList.contains('show')) pasteText.focus();
});

// Action rows: Try a sample
$('#actTrySample').addEventListener('click', () => {
  const sampleText = `CHAPTER 1: THE FORGOTTEN ART

We forgot how to read. Not the skill. The art. The art of reading subtleties, of understanding the weight behind silence, is what separates good listeners from great ones. And yet, somewhere along the way, we forgot how to truly read.

Consider the last book that moved you. Not the pleasantries exchanged at the coffee shop, but the kind of conversation where something shifted — where understanding deepened, or a decision was made that would echo for years. In those moments, words are only part of the equation. The pauses between sentences carry meaning. The choice to look away or hold eye contact tells its own story.

Reading is the same. One sentence at a time. When we read with intention, giving each thought the space it deserves, we begin to hear what the author isn't saying. We catch the nuances, the deliberate word choices, the structure that reveals deeper meaning.

We scan. We skim. We rush. We consume content like fast food, rushing through paragraphs to get to the conclusion. But the richest ideas don't live in conclusions — they live in the journey between sentences.

CHAPTER 2: THE SCIENCE OF ATTENTION

Your brain wasn't built for this world. Every notification, every headline, every flashing pixel competes for the same limited resource: our attention. And attention, unlike time, cannot be saved or stored. It can only be spent.

Deep reading activates different brain pathways. When you read slowly and with focus, the brain engages regions associated with empathy, sensory processing, and long-term memory formation. You don't just understand the words — you feel them.

Skimming keeps the brain shallow. Information enters and exits without leaving a trace. This is why you can read an entire article and, moments later, struggle to recall a single detail. The words passed through you like water through a sieve.

The fix isn't reading less. It's reading differently. To give your attention fully to one sentence before moving to the next. To treat each paragraph not as an obstacle between you and the conclusion, but as a destination in itself.

CHAPTER 3: THE RHYTHM OF WORDS

Great writers have rhythm. Hemingway's sentences are short, sharp, percussive — like stones skipping across water. Virginia Woolf's prose flows and meanders, pulling you into an interior world that feels more real than the room you're sitting in. Dostoevsky builds tension through accumulation, stacking clause upon clause until the weight becomes almost unbearable.

Read too fast and you miss it. It's like listening to music on fast-forward — you can identify the song, but you can't feel it. The melody disappears. The spaces between notes, which give music its emotional power, collapse into nothing.

Focused reading restores this. It lets you feel the cadence of a well-crafted sentence, the deliberate pause of a period, the breathless rush of a long compound thought. You begin to hear the author's voice, not just their words.

Try it now. Read slowly. Let each word land before moving to the next. Notice how the meaning deepens when you give it time to unfold.

CHAPTER 4: THE ARCHITECTURE OF UNDERSTANDING

A book is not a list of sentences. It is an architecture — a carefully constructed building of ideas, where each paragraph supports the next, and the whole is greater than the sum of its parts.

When you skim, you see the building from a distance. You can identify its shape, count its floors, note its color. But you never walk inside. You never discover the hidden room behind the staircase, the window that frames the garden just so, the way the light falls differently in each room throughout the day.

Deep reading is walking through that building. It is opening every door, sitting in every chair, looking out of every window. It is discovering that what seemed like a simple structure from the outside contains infinities within.

Some books reward re-reading. Not because the words change, but because you do. Each time you enter the building, you notice something different. A doorway you missed before. A view you weren't ready to appreciate. A room that means something entirely new now that you've lived a little more.

CHAPTER 5: THE PRACTICE OF STILLNESS

There is courage in stillness. In a world that rewards constant motion, choosing to sit with a single page, a single paragraph, a single sentence — this is an act of quiet rebellion.

Zen calls it beginner's mind. The practice of approaching each moment as if experiencing it for the first time. When we read with beginner's mind, even familiar words become fresh. A sentence we've read a hundred times suddenly reveals a meaning we never noticed.

Don't force slowness. You simply stop forcing yourself to read fast. You let go of the compulsion to finish, to get through it, to reach the end. You allow yourself to be exactly where you are in the text, without rushing toward where you think you should be.

Something remarkable happens. The boundary between reader and text begins to dissolve. You stop reading about an experience and start having one. The words become transparent, and what shines through them is pure meaning.

CHAPTER 6: READING AS EMPATHY

Read a novel deeply. You don't just follow a character's story — you inhabit their consciousness. You feel their fears, share their hopes, suffer their disappointments. For a few hours, you live inside another mind.

This isn't metaphor. Brain imaging studies show that reading literary fiction activates the same neural networks involved in understanding other people's mental states. The more deeply you read, the more your brain practices empathy.

Every book is a bridge. Every character is a person you haven't met. Every story is a world you haven't visited. But only if you read slowly enough to actually cross the bridge, meet the person, and visit the world.

CHAPTER 7: THE DIGITAL PARADOX

We have more text than ever. Libraries that once took lifetimes to assemble now fit in our pockets. The complete works of Shakespeare, the entire corpus of ancient philosophy, the latest research from every field — all available in seconds.

Yet we read less deeply. The paradox of abundance is that it breeds superficiality. When everything is available, nothing feels essential. When you can read anything, you end up reading nothing — at least, nothing with the attention it deserves.

The answer isn't less reading. It's more intention. Choose fewer things and read them more deeply. Treat a single essay with the same attention you'd give a conversation with someone you love.

CHAPTER 8: THE GIFT OF TIME

Reading slows time. When you're deep in a book, hours can pass that feel like minutes — but the memories formed in those hours are rich and detailed, making the time feel expanded in retrospect.

This is the gift. It doesn't just help you understand ideas better. It gives you something increasingly rare: the experience of time that feels fully lived. Not time that slipped away while you scrolled, or evaporated while you multitasked, but time that you inhabited completely.

Every focused sentence is a present moment. And a life made up of such moments — even if they're spent in a chair, with a book, in silence — is a life deeply lived.

CHAPTER 9: BEGINNING AGAIN

You can start now. Right now. With the very next sentence you read.

No training needed. No equipment. You simply need to decide, for this one sentence, to be fully here. To let the words land. To notice not just what they say, but how they make you feel.

And then you do it again. And the next.

This is the entire practice. Nothing more. Nothing less.`;
  state.documentTitle = 'The Art of Focused Reading';
  state.isSample = true;
  processText(sampleText);
});

// Action rows: Enter URL (disabled for now)
$('#actEnterUrl').addEventListener('click', () => {
  // Coming soon
});

// Mobile settings: mode pills
$$('#mobileModeGroup .ms-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    setMode(btn.dataset.mode);
    syncMobileSettingsUI();
  });
});

// Mobile settings: theme cycle
$('#mobileThemeCycle').addEventListener('click', () => {
  toggleTheme();
  syncMobileSettingsUI();
});

// Mobile settings: font cycle
const fontCycleOrder = ['serif', 'sans', 'mono'];
$('#mobileFontCycle').addEventListener('click', () => {
  const current = $('#fontSelect').value;
  const idx = fontCycleOrder.indexOf(current);
  const next = fontCycleOrder[(idx + 1) % fontCycleOrder.length];
  setFont(next);
  $('#fontSelect').value = next;
  saveSettings();
  syncMobileSettingsUI();
});

// Mobile settings: speed
$('#mobileSpeedDown').addEventListener('click', () => {
  speedSlider.value = Math.max(1, parseInt(speedSlider.value) - 5);
  state.speed = parseInt(speedSlider.value);
  updateSpeedLabel(); saveSettings(); syncMobileSettingsUI();
  if (state.playing) { clearTimeout(state.timer); advance(); }
});
$('#mobileSpeedUp').addEventListener('click', () => {
  speedSlider.value = Math.min(100, parseInt(speedSlider.value) + 5);
  state.speed = parseInt(speedSlider.value);
  updateSpeedLabel(); saveSettings(); syncMobileSettingsUI();
  if (state.playing) { clearTimeout(state.timer); advance(); }
});

// Mobile settings: font size
$('#mobileFontDown').addEventListener('click', () => {
  state.fontSize = Math.max(0.7, state.fontSize - 0.1);
  applyFontSize(); saveSettings(); syncMobileSettingsUI();
});
$('#mobileFontUp').addEventListener('click', () => {
  state.fontSize = Math.min(2.5, state.fontSize + 0.1);
  applyFontSize(); saveSettings(); syncMobileSettingsUI();
});

// ── Onboarding Tour ──
const tour = {
  active: false,
  step: 0,
  steps: [
    {
      title: 'Tap to play',
      text: 'Tap the play button or anywhere on the screen to start reading.',
      hint: 'Tap anywhere to play',
      target: 'play-button',
      interactive: 'tap-to-play',
    },
    {
      title: 'Great! Now tap to pause',
      text: 'Tap anywhere on the reading area to pause and see your progress.',
      hint: 'Tap anywhere to pause',
      target: 'reading-area',
      interactive: 'tap-to-pause',
    },
    {
      title: 'Your reading info',
      text: 'See your chapter name, time remaining, and reading progress here.',
      hint: 'Swipe up to continue',
      target: 'bottom-sheet',
      interactive: 'swipe-up',
    },
    {
      title: 'Customize your experience',
      text: 'Adjust reading speed to match your pace, change focus mode, theme, and font.',
      hint: 'Try switching to dark theme, then swipe down',
      target: 'settings-sheet',
      interactive: 'swipe-down',
    },
    {
      title: 'Go immersive',
      text: 'Tap fullscreen for distraction-free reading experience. Tap X to exit the book.',
      hint: 'Tap the fullscreen button',
      target: 'header',
      interactive: 'fullscreen',
      lastStep: true,
    },
  ],

  shouldShow() {
    return !localStorage.getItem('thefocusreader_tour_done');
  },

  start() {
    if (!this.shouldShow()) return;
    this.active = true;
    this.step = 0;
    $('#tourOverlay').classList.add('active');
    this.render();
  },

  next() {
    this.step++;
    if (this.step >= this.steps.length) {
      this.finish();
      return;
    }
    this.render();
  },

  finish() {
    this.active = false;
    $('#tourOverlay').classList.remove('active');
    localStorage.setItem('thefocusreader_tour_done', '1');
    const old = $('#tourOverlay').querySelector('.tour-spotlight, .tour-spotlight-rect');
    if (old) old.remove();
    const readerEl = document.querySelector('.reader');
    if (readerEl) readerEl.style.paddingBottom = '';
    ['#mobileCenterPlay', '#mobilePauseSheet', '#reader'].forEach(sel => {
      const el = $(sel);
      if (el) el.style.zIndex = '';
    });
  },

  // Called externally when user completes an interactive action
  onAction(action) {
    if (!this.active && !this._pauseTimer) return;
    // Handle early pause — user paused during the 7s reading window
    if (action === 'tap-to-pause' && this._pauseTimer) {
      action = 'early-pause';
    }
    const s = this.steps[this.step];
    if (s.interactive === action || action === 'early-pause') {
      if (action === 'tap-to-play') {
        // Hide overlay, let user enjoy reading, then show "tap to pause"
        $('#tourOverlay').classList.remove('active');
        this._pauseTimer = setTimeout(() => {
          this._pauseTimer = null;
          this.step++;
          $('#tourOverlay').classList.add('active');
          this.render();
        }, 10000);
      } else if (action === 'tap-to-pause' || action === 'early-pause') {
        // Cancel the pending timer if user paused early
        if (this._pauseTimer) {
          clearTimeout(this._pauseTimer);
          this._pauseTimer = null;
        }
        // Go to reading info step (step index 2)
        $('#tourOverlay').classList.remove('active');
        setTimeout(() => {
          this.step = 2; // "Your reading info" step
          $('#tourOverlay').classList.add('active');
          this.render();
        }, 500);
      } else if (action === 'swipe-up') {
        // Settings opened — hide overlay instantly, show settings step after brief pause
        $('#tourOverlay').classList.remove('active');
        setTimeout(() => {
          this.step++;
          $('#tourOverlay').classList.add('active');
          this.render();
        }, 800);
      } else if (action === 'swipe-down') {
        // Settings closed — show next step or finish if last
        $('#tourOverlay').classList.remove('active');
        if (s.lastStep) {
          setTimeout(() => this.finish(), 400);
        } else {
          setTimeout(() => {
            this.step++;
            $('#tourOverlay').classList.add('active');
            this.render();
          }, 800);
        }
      } else if (action === 'fullscreen') {
        // Fullscreen toggled — finish tour
        setTimeout(() => this.finish(), 500);
      }
    }
  },

  render() {
    const s = this.steps[this.step];
    const overlay = $('#tourOverlay');
    const tooltip = $('#tourTooltip');

    $('#tourGesture').style.display = 'none';

    // Re-trigger tooltip animation
    tooltip.style.animation = 'none';
    tooltip.offsetHeight; // force reflow
    tooltip.style.animation = 'tourFadeIn 0.5s ease';

    // Title, text, action hint
    $('#tourTitle').textContent = s.title;
    let textHtml = s.text;
    if (s.hint) textHtml += '<div class="tour-action-hint">' + s.hint + '</div>';
    $('#tourText').innerHTML = textHtml;

    // Button — hide "Next" for interactive steps, show for non-interactive
    if (s.interactive) {
      $('#tourNext').style.display = 'none';
    } else {
      $('#tourNext').style.display = '';
      $('#tourNext').textContent = s.lastStep ? 'Got it!' : 'Next';
    }
    $('#tourSkip').style.display = s.lastStep ? 'none' : '';

    // Step counter + footer visibility
    $('#tourStepCounter').textContent = s.lastStep ? '' : (this.step + 1) + ' / ' + this.steps.length;
    $('.tour-tip-footer').style.display = (s.interactive && s.lastStep) ? 'none' : '';

    // Remove old spotlight & arrows, reset z-index and overlay state
    const oldSpot = overlay.querySelector('.tour-spotlight, .tour-spotlight-rect');
    if (oldSpot) oldSpot.remove();
    const oldArrows = tooltip.querySelectorAll('.tour-arrow-up, .tour-arrow-down');
    oldArrows.forEach(a => a.remove());
    overlay.style.pointerEvents = '';
    delete overlay.dataset.tapAction;
    $('#tourBackdrop').style.background = '';
    const readerEl = document.querySelector('.reader');
    if (readerEl) readerEl.style.paddingBottom = '';
    ['#mobileCenterPlay', '#mobilePauseSheet', '#reader'].forEach(sel => {
      const el = $(sel);
      if (el) el.style.zIndex = '';
    });

    if (s.target === 'play-button') {
      // Light backdrop — keep the paused UI visible
      $('#tourBackdrop').style.background = 'rgba(0,0,0,0.15)';

      const playBtn = $('#mobileCenterPlay');
      if (playBtn) {
        // Make play button and screen tappable through overlay
        playBtn.style.zIndex = '102';
        overlay.style.pointerEvents = 'auto';
        overlay.dataset.tapAction = 'tap-to-play';
      }

      // Tooltip below center of screen (below play button area)
      const cy = window.innerHeight * 0.55;
      tooltip.style.cssText = `top:${cy}px;left:50%;transform:translateX(-50%);`;
      const arrow = document.createElement('div');
      arrow.className = 'tour-arrow-up';
      tooltip.insertBefore(arrow, tooltip.firstChild);

    } else if (s.target === 'reading-area') {
      // Light backdrop so reading stays visible
      $('#tourBackdrop').style.background = 'rgba(0,0,0,0.15)';
      // Make the entire overlay tappable to trigger pause
      overlay.style.pointerEvents = 'auto';
      overlay.dataset.tapAction = 'tap-to-pause';

      // Tooltip near bottom so reading area stays visible above
      tooltip.style.cssText = `bottom:24px;left:50%;transform:translateX(-50%);`;

      // Add padding so focused text stays above tooltip
      setTimeout(() => {
        const tooltipRect = tooltip.getBoundingClientRect();
        const blockedHeight = window.innerHeight - tooltipRect.top + 10;
        document.querySelector('.reader').style.paddingBottom = blockedHeight + 'px';
      }, 100);

    } else if (s.target === 'bottom-sheet') {
      // Light backdrop — same as step 1
      $('#tourBackdrop').style.background = 'rgba(0,0,0,0.15)';

      const sheet = $('#mobilePauseSheet');
      if (sheet) {
        // Make sheet interactive through overlay
        sheet.style.zIndex = '102';

        // Tooltip above sheet
        const rect = sheet.getBoundingClientRect();
        tooltip.style.cssText = `bottom:${window.innerHeight - rect.top + 18}px;left:50%;transform:translateX(-50%);`;
        const arrow = document.createElement('div');
        arrow.className = 'tour-arrow-down';
        tooltip.appendChild(arrow);
      }

    } else if (s.target === 'settings-sheet') {
      // No spotlight — keep reading area visible for live preview
      $('#tourBackdrop').style.background = 'rgba(0,0,0,0.1)';

      const sheet = $('#mobilePauseSheet');
      if (sheet) {
        sheet.style.zIndex = '102';

        const rect = sheet.getBoundingClientRect();
        // Tooltip just above settings sheet
        tooltip.style.cssText = `bottom:${window.innerHeight - rect.top + 14}px;left:50%;transform:translateX(-50%);`;
        const arrow = document.createElement('div');
        arrow.className = 'tour-arrow-down';
        tooltip.appendChild(arrow);

        // Ensure reading is playing for live preview
        if (!state.playing && state.units.length > 0) {
          state.playing = true;
          playPauseBtn.innerHTML = '&#9646;&#9646;';
          advance();
        }

        // Add extra padding after tooltip renders so scrollToUnit keeps text visible
        setTimeout(() => {
          const tooltipRect = tooltip.getBoundingClientRect();
          const blockedHeight = window.innerHeight - tooltipRect.top + 10;
          document.querySelector('.reader').style.paddingBottom = blockedHeight + 'px';
        }, 100);
      }

    } else if (s.target === 'header') {
      // Light backdrop
      $('#tourBackdrop').style.background = 'rgba(0,0,0,0.15)';

      const header = $('.header');
      const fsBtn = $('#fullscreenBtn');
      if (header) {
        // Make header interactive
        header.style.zIndex = '102';

        const rect = header.getBoundingClientRect();
        // Tooltip below header
        tooltip.style.cssText = `top:${rect.bottom + 14}px;left:50%;transform:translateX(-50%);`;
        const arrow = document.createElement('div');
        arrow.className = 'tour-arrow-up';
        // Point arrow at fullscreen button
        if (fsBtn) {
          const fsRect = fsBtn.getBoundingClientRect();
          const tooltipLeft = (window.innerWidth - tooltip.offsetWidth) / 2;
          const arrowLeft = fsRect.left + fsRect.width / 2 - tooltipLeft - 8;
          arrow.style.left = arrowLeft + 'px';
          arrow.style.transform = 'none';
        }
        tooltip.insertBefore(arrow, tooltip.firstChild);
      }
    }
  }
};

$('#tourNext').addEventListener('click', (e) => { e.stopPropagation(); tour.next(); });
$('#tourSkip').addEventListener('click', (e) => { e.stopPropagation(); tour.finish(); });
$('#tourTooltip').addEventListener('click', (e) => { e.stopPropagation(); });
$('#tourOverlay').addEventListener('click', () => {
  const action = $('#tourOverlay').dataset.tapAction;
  if (action === 'tap-to-pause') {
    delete $('#tourOverlay').dataset.tapAction;
    pause();
    tour.onAction('tap-to-pause');
  } else if (action === 'tap-to-play') {
    delete $('#tourOverlay').dataset.tapAction;
    play();
    tour.onAction('tap-to-play');
  }
});

// ── Dictionary Lookup ──
(function() {
  let longPressTimer = null;
  let longPressTriggered = false;
  let activeCard = null;
  let activeWord = null;

  function getWordAtTouch(e) {
    const touch = e.touches ? e.touches[0] : e;
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    if (el && el.classList.contains('word')) return el;
    return null;
  }

  function cleanWord(text) {
    return text.replace(/[^a-zA-Z'-]/g, '').toLowerCase();
  }

  function dismissCard() {
    if (activeCard) { activeCard.remove(); activeCard = null; }
    if (activeWord) { activeWord.classList.remove('word-lookup'); activeWord = null; }
  }

  async function lookupWord(wordEl) {
    const raw = cleanWord(wordEl.textContent);
    if (!raw || raw.length < 2) return;

    // Pause reading if playing
    if (state.playing) pause();

    dismissCard();
    activeWord = wordEl;
    wordEl.classList.add('word-lookup');

    // Create card with loading state
    const card = document.createElement('div');
    card.className = 'dict-card';
    card.innerHTML = '<div class="dict-loading">Looking up...</div>';
    reader.appendChild(card);
    activeCard = card;

    // Position card near the word
    positionCard(card, wordEl);

    // Fetch definition
    try {
      const resp = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(raw));
      if (!resp.ok) throw new Error('not found');
      const data = await resp.json();
      const entry = data[0];
      const meaning = entry.meanings[0];
      const def = meaning.definitions[0];

      let html = '<div class="dict-arrow up"></div>';
      html += '<div class="dict-header">';
      html += '<div class="dict-word">' + escHtml(entry.word) + '</div>';
      if (entry.phonetic) html += '<div class="dict-phonetic">' + escHtml(entry.phonetic) + '</div>';
      html += '</div>';
      html += '<div class="dict-pos">' + escHtml(meaning.partOfSpeech) + '</div>';
      html += '<div class="dict-def">' + escHtml(def.definition) + '</div>';
      if (def.example) html += '<div class="dict-example">"' + escHtml(def.example) + '"</div>';

      card.innerHTML = html;
      positionCard(card, wordEl);
    } catch(e) {
      card.innerHTML = '<div class="dict-arrow up"></div><div class="dict-error">No definition found for "' + escHtml(raw) + '"</div>';
      positionCard(card, wordEl);
    }
  }

  function positionCard(card, wordEl) {
    const readerRect = reader.getBoundingClientRect();
    const wordRect = wordEl.getBoundingClientRect();
    const wordTop = wordRect.top - readerRect.top + reader.scrollTop;
    const wordLeft = wordRect.left - readerRect.left;
    const wordCenterX = wordLeft + wordRect.width / 2;

    // Position below word by default
    card.style.top = (wordTop + wordRect.height + 10) + 'px';

    // Horizontal: center on word, clamp to reader bounds
    const cardWidth = card.offsetWidth || 280;
    let left = wordCenterX - cardWidth / 2;
    left = Math.max(4, Math.min(left, readerRect.width - cardWidth - 4));
    card.style.left = left + 'px';

    // Arrow position
    const arrowX = wordCenterX - left;
    card.style.setProperty('--arrow-x', Math.max(16, Math.min(arrowX, cardWidth - 16)) + 'px');

    // If card goes below viewport, show above word instead
    const cardBottom = wordRect.bottom + 10 + (card.offsetHeight || 100);
    if (cardBottom > window.innerHeight - 20) {
      card.style.top = (wordTop - (card.offsetHeight || 100) - 10) + 'px';
      // Switch arrow to down
      const arrow = card.querySelector('.dict-arrow');
      if (arrow) { arrow.classList.remove('up'); arrow.classList.add('down'); }
    }
  }

  // Mobile: long-press detection
  readerContent.addEventListener('touchstart', (e) => {
    longPressTriggered = false;
    const wordEl = getWordAtTouch(e);
    if (!wordEl) return;
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      lookupWord(wordEl);
    }, 500);
  }, { passive: true });

  readerContent.addEventListener('touchmove', () => {
    clearTimeout(longPressTimer);
  }, { passive: true });

  readerContent.addEventListener('touchend', (e) => {
    clearTimeout(longPressTimer);
    if (longPressTriggered) {
      e.preventDefault();
      longPressTriggered = false;
    }
  });

  // Desktop: double-click detection
  readerContent.addEventListener('dblclick', (e) => {
    const wordEl = e.target.closest('.word');
    if (wordEl) lookupWord(wordEl);
  });

  // Dismiss on outside tap/click
  document.addEventListener('click', (e) => {
    if (!activeCard) return;
    if (activeCard.contains(e.target)) return;
    if (activeWord && activeWord.contains(e.target)) return;
    dismissCard();
  });

  document.addEventListener('touchstart', (e) => {
    if (!activeCard) return;
    if (activeCard.contains(e.target)) return;
    if (activeWord && activeWord.contains(e.target)) return;
    dismissCard();
  }, { passive: true });
})();

// ── Init ──
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
if (isIOS) {
  $('#fullscreenBtn').style.display = 'none';
  // Remove fullscreen tour step on iOS
  tour.steps = tour.steps.filter(s => s.target !== 'header');
  // Mark new last step
  if (tour.steps.length > 0) tour.steps[tour.steps.length - 1].lastStep = true;
}
loadSettings();
updateThemeIcon();
updateSpeedLabel();
applyFontSize();
updateFontSizeDisplay();
renderSavedSessions();