const scenes = {
  draft: {
    kicker: "WEEK OF JUL 27",
    state: "DRAFT",
    title: "The week, plated.",
    footnote: "5 days · 5 categories",
    messages: [
      { type: "bot", html: "<strong>Your draft is ready.</strong> I kept carbs to one night and included prep notes." },
      { type: "user", html: "Show me the week." }
    ],
    rows: [
      ["MON", "Mix Veg Paneer", "Lemon Pepper Chicken"],
      ["TUE", "Chicken Curry", "no side needed"],
      ["THU", "Palak Paneer", "Tandoori Chicken"],
      ["FRI", "Hakka Noodles", "Cajun Chicken"],
      ["SAT", "Egg Curry", "Lemon Pepper Chicken"]
    ]
  },
  edit: {
    kicker: "SATURDAY · UPDATED",
    state: "VALID",
    title: "A change, not a reroll.",
    footnote: "repeat is non-consecutive",
    messages: [
      { type: "user", html: "Use Lemon Pepper Chicken on Saturday too." },
      { type: "bot", html: "<strong>Done.</strong> It last appears Monday, so the repeat is valid." }
    ],
    rows: [
      ["BEFORE", "Egg Curry", "no chicken side"],
      ["AFTER", "Egg Curry", "Lemon Pepper Chicken"],
      ["RULE", "Side repeats", "not consecutive"]
    ]
  },
  memory: {
    kicker: "PERSONAL MEMORY",
    state: "SAVED",
    title: "Context that survives.",
    footnote: "visible only to this speaker",
    messages: [
      { type: "user", html: "Remember that I prefer less spicy food." },
      { type: "bot", html: "<strong>Remembered for you.</strong> I’ll keep that separate from your brother’s preferences." }
    ],
    rows: [
      ["WHO", "Aniket", "Telegram ID matched"],
      ["SCOPE", "Personal", "not household"],
      ["NOTE", "Less spicy food", "durable memory"]
    ]
  }
};

const tabs = [...document.querySelectorAll(".simulation-tab")];
const messages = document.querySelector("#sim-messages");
const content = document.querySelector("#sim-content");
const kicker = document.querySelector("#sim-kicker");
const state = document.querySelector("#sim-state");
const title = document.querySelector("#sim-title");
const footnote = document.querySelector("#sim-footnote");
const panel = document.querySelector("#simulation-panel");

function renderScene(name) {
  const scene = scenes[name];
  if (!scene || !messages || !content) return;

  messages.replaceChildren(
    ...scene.messages.map((message) => {
      const bubble = document.createElement("div");
      bubble.className = `sim-bubble${message.type === "user" ? " user" : ""}`;
      bubble.innerHTML = message.html;
      return bubble;
    })
  );

  content.replaceChildren(
    ...scene.rows.map(([day, dish, detail]) => {
      const row = document.createElement("div");
      row.className = "menu-row";

      const dayLabel = document.createElement("b");
      dayLabel.textContent = day;

      const dishBlock = document.createElement("div");
      const dishName = document.createElement("strong");
      const dishDetail = document.createElement("small");
      dishName.textContent = dish;
      dishDetail.textContent = detail;
      dishBlock.append(dishName, dishDetail);

      const check = document.createElement("span");
      check.textContent = "✓";
      row.append(dayLabel, dishBlock, check);
      return row;
    })
  );

  kicker.textContent = scene.kicker;
  state.textContent = scene.state;
  title.textContent = scene.title;
  footnote.textContent = scene.footnote;
  panel.setAttribute("aria-labelledby", `tab-${name}`);

  for (const tab of tabs) {
    const selected = tab.dataset.scene === name;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => renderScene(tab.dataset.scene));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const current = tabs.indexOf(tab);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(current + direction + tabs.length) % tabs.length];
    next.focus();
    renderScene(next.dataset.scene);
  });
}

const year = document.querySelector("#year");
if (year) year.textContent = String(new Date().getFullYear());
renderScene("draft");
