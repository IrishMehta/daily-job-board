const TOUR_STORAGE_KEY = "jobDiscoveryBoard:product-tour:v1";

function compactViewport() {
  return window.matchMedia("(max-width: 840px), (max-height: 600px) and (max-width: 1000px)").matches;
}

const STEPS = [
  {
    target: () => document.querySelector(".search-field"),
    title: "Start with a question",
    copy: "Search roles, skills, companies, or locations. The board understands everyday job-search terms and common typos.",
  },
  {
    target: () => compactViewport()
      ? document.getElementById("mobile-filter-open")
      : document.getElementById("filter-panel"),
    title: "Narrow the board",
    copy: "Use Focus, location, experience, authorization, and posting-date filters to keep only realistic options in view.",
  },
  {
    target: () => document.getElementById("job-list"),
    title: "Scan the live results",
    copy: "Each result shows the role, company, location, experience, and authorization signal so you can compare quickly.",
  },
  {
    target: () => compactViewport()
      ? document.getElementById("job-list")
      : document.getElementById("detail-pane"),
    title: "Open the full posting",
    copy: "Select a result to inspect the summary, requirements, location, and application link without losing your place.",
  },
  {
    target: () => document.getElementById("resume-open"),
    title: "Try private resume matching",
    copy: "Paste your resume to sort roles by local relevance. Your resume stays in this browser and is never uploaded.",
  },
  {
    target: () => document.querySelector(".market-action"),
    title: "Step back and read the market",
    copy: "Market trends summarizes hiring demand, pay, locations, experience mix, and skills across the current window.",
  },
];

function wasSeen() {
  try {
    return window.localStorage.getItem(TOUR_STORAGE_KEY) === "seen";
  } catch {
    return false;
  }
}

function rememberSeen() {
  try {
    window.localStorage.setItem(TOUR_STORAGE_KEY, "seen");
  } catch {
    // The tour still works when browser storage is unavailable.
  }
}

export function createProductTour() {
  const root = document.getElementById("product-tour");
  if (!root) return { start() {}, autoStart() {} };

  const card = document.getElementById("tour-card");
  const spotlight = document.getElementById("tour-spotlight");
  const title = document.getElementById("tour-title");
  const copy = document.getElementById("tour-copy");
  const stepCount = document.getElementById("tour-step-count");
  const skip = document.getElementById("tour-skip");
  const back = document.getElementById("tour-back");
  const next = document.getElementById("tour-next");
  const launchers = document.querySelectorAll("[data-tour-launch]");
  let stepIndex = 0;
  let active = false;
  let complete = false;
  let previousFocus = null;

  function currentTarget() {
    return STEPS[stepIndex]?.target() || null;
  }

  function focusableElements() {
    return [...card.querySelectorAll("button:not([disabled]), [href], input, select, textarea")]
      .filter((element) => element.getClientRects().length > 0);
  }

  function position() {
    if (!active) return;
    const target = currentTarget();
    if (complete || !target) {
      spotlight.classList.add("hidden");
      card.style.width = `${Math.min(420, window.innerWidth - 32)}px`;
      card.style.left = `${Math.max(16, (window.innerWidth - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.max(16, (window.innerHeight - card.offsetHeight) / 2)}px`;
      return;
    }
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      spotlight.classList.add("hidden");
      card.style.width = `${Math.min(380, window.innerWidth - 32)}px`;
      card.style.left = `${Math.max(16, (window.innerWidth - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.max(16, (window.innerHeight - card.offsetHeight) / 2)}px`;
      return;
    }

    spotlight.classList.remove("hidden");
    const padding = 8;
    spotlight.style.top = `${Math.max(4, rect.top - padding)}px`;
    spotlight.style.left = `${Math.max(4, rect.left - padding)}px`;
    spotlight.style.width = `${rect.width + padding * 2}px`;
    spotlight.style.height = `${rect.height + padding * 2}px`;
    spotlight.style.borderRadius = getComputedStyle(target).borderRadius || "10px";

    const cardWidth = Math.min(380, window.innerWidth - 32);
    card.style.width = `${cardWidth}px`;
    const cardHeight = card.offsetHeight;
    const left = Math.min(Math.max(16, rect.left), Math.max(16, window.innerWidth - cardWidth - 16));
    const roomBelow = window.innerHeight - rect.bottom - 18;
    const top = roomBelow >= cardHeight || rect.top < cardHeight + 28
      ? rect.bottom + 18
      : rect.top - cardHeight - 18;
    card.style.left = `${left}px`;
    card.style.top = `${Math.max(16, Math.min(top, window.innerHeight - cardHeight - 16))}px`;
  }

  function renderStep() {
    const step = STEPS[stepIndex];
    complete = false;
    card.classList.remove("is-complete");
    title.textContent = step.title;
    copy.textContent = step.copy;
    stepCount.textContent = `${stepIndex + 1} of ${STEPS.length}`;
    back.classList.toggle("hidden", stepIndex === 0);
    next.textContent = stepIndex === STEPS.length - 1 ? "Done" : "Next";
    window.requestAnimationFrame(position);
  }

  function renderCompletion() {
    complete = true;
    spotlight.classList.add("hidden");
    card.classList.add("is-complete");
    title.textContent = "You’re ready to explore";
    copy.textContent = "That’s the whole workflow. You can replay this guide anytime from the Guide button in the header.";
    stepCount.textContent = "Tour complete";
    back.classList.add("hidden");
    next.textContent = "Start exploring";
    window.requestAnimationFrame(position);
  }

  function close({ remember = true } = {}) {
    if (!active) return;
    active = false;
    root.classList.add("hidden");
    root.setAttribute("aria-hidden", "true");
    spotlight.removeAttribute("style");
    spotlight.classList.remove("hidden");
    card.classList.remove("is-complete");
    if (remember) rememberSeen();
    if (previousFocus && typeof previousFocus.focus === "function") {
      previousFocus.focus({ preventScroll: true });
    }
    previousFocus = null;
  }

  function activate() {
    active = true;
    complete = false;
    root.classList.remove("hidden");
    root.setAttribute("aria-hidden", "false");
    renderStep();
    window.setTimeout(() => {
      if (active) (stepIndex === 0 ? next : card).focus();
    }, 0);
  }

  function start() {
    previousFocus = document.activeElement;
    const allJobs = document.querySelector('[data-view="all"]');
    if (allJobs && !allJobs.classList.contains("is-active")) {
      allJobs.click();
      window.setTimeout(activate, 80);
      return;
    }
    activate();
  }

  function advance() {
    if (complete) {
      close();
      return;
    }
    if (stepIndex === STEPS.length - 1) {
      rememberSeen();
      renderCompletion();
      return;
    }
    stepIndex += 1;
    renderStep();
  }

  function retreat() {
    if (stepIndex === 0) return;
    stepIndex -= 1;
    renderStep();
  }

  launchers.forEach((launcher) => launcher.addEventListener("click", () => {
    stepIndex = 0;
    start();
  }));
  skip.addEventListener("click", () => close());
  back.addEventListener("click", retreat);
  next.addEventListener("click", advance);
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-tour-close]")) close();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = focusableElements();
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);

  return {
    start,
    autoStart() {
      if (!wasSeen()) start();
    },
  };
}
