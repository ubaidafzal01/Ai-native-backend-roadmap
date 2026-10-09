// Fade sections in as they scroll into view
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

// Show the floating dock once the hero is scrolled past
const dock = document.getElementById('dock');
new IntersectionObserver(([entry]) => {
  dock.classList.toggle('show', !entry.isIntersecting);
}, { threshold: 0.15 }).observe(document.querySelector('.hero'));

// Highlight the dock item for the section on screen
const dockLinks = [...dock.querySelectorAll('a')];
const sectionObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    const id = entry.target.id === 'tamara' ? 'checklist' : entry.target.id;
    dockLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${id}`));
  });
}, { rootMargin: '-45% 0px -50% 0px' });
document.querySelectorAll('main .section').forEach((s) => sectionObserver.observe(s));

// Readiness checklist: progress ring + saved in this browser
const STORE_KEY = 'roadmap-checklist-v1';
const boxes = [...document.querySelectorAll('.check input')];
const ring = document.getElementById('ring');
const ringText = document.getElementById('ring-text');

const load = () => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
};
const save = (state) => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
};
const updateRing = () => {
  const done = boxes.filter((b) => b.checked).length;
  ring.style.setProperty('--p', Math.round((done / boxes.length) * 100));
  ringText.textContent = `${done}/${boxes.length}`;
};

const state = load();
boxes.forEach((box) => {
  box.checked = !!state[box.dataset.id];
  box.addEventListener('change', () => {
    state[box.dataset.id] = box.checked;
    save(state);
    updateRing();
  });
});
document.getElementById('reset').addEventListener('click', () => {
  boxes.forEach((b) => { b.checked = false; state[b.dataset.id] = false; });
  save(state);
  updateRing();
});
updateRing();
