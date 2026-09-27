// 民主主義Bot Web dashboard. Every piece of text is inserted as a text node (never as HTML).

const app = document.getElementById("app");
const account = document.getElementById("account");
const toastBox = document.getElementById("toast");

const TABS = [
  ["government", "政府"],
  ["election", "選挙"],
  ["parliament", "国会"],
  ["court", "裁判所"],
  ["petitions", "請願"],
  ["gazette", "官報"],
];

const STATUS_TONE = {
  REGISTRATION: "live",
  VOTING: "live",
  DELIBERATION: "live",
  OPEN: "live",
  FILED: "live",
  IN_TRIAL: "live",
  VERDICT: "live",
  APPEALED: "live",
  PASSED: "warn",
  VETOED: "bad",
  COMPLETED: "ok",
  ENACTED: "ok",
  IMPLEMENTED: "ok",
  FINAL: "ok",
  SUBMITTED: "ok",
  REJECTED: "bad",
  CANCELLED: "bad",
  EXPIRED: "plain",
  LAPSED: "plain",
  WITHDRAWN: "plain",
};

// ───────────── DOM helpers

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

/** Like el.replaceChildren(), but flattens arrays and skips null/false children. */
function replace(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const dateTime = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const dateOnly = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });
const fmt = (iso) => (iso ? dateTime.format(new Date(iso)) : "—");
const fmtDate = (iso) => (iso ? dateOnly.format(new Date(iso)) : "—");

function relative(iso) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(Math.round(seconds), "second");
}

function deadline(iso) {
  return h("time", { datetime: iso, title: fmt(iso) }, `${fmt(iso)}（${relative(iso)}）`);
}

/** Renders stored text: keeps line breaks and turns {{t:unix}} tokens into local times. */
function richText(text, tag = "div", cls = "rich") {
  const el = h(tag, { class: cls });
  const parts = String(text ?? "").split(/\{\{t:(\d+)\}\}/);
  parts.forEach((part, index) => {
    if (index % 2 === 0) el.append(document.createTextNode(part));
    else {
      const iso = new Date(Number(part) * 1000).toISOString();
      el.append(h("time", { datetime: iso }, fmt(iso)));
    }
  });
  return el;
}

/** The name's first character in a circle; used when there is no avatar or it fails to load. */
function initialAvatar(name, size) {
  const el = h("span", { class: "avatar avatar-fallback", "aria-hidden": "true" }, Array.from(String(name ?? "?").trim())[0] ?? "?");
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * 0.45)}px`;
  return el;
}

function avatar(url, size = 28, name = "") {
  if (!url) return initialAvatar(name, size);
  const img = h("img", { class: "avatar", src: url, alt: "", width: size, height: size, loading: "lazy", referrerpolicy: "no-referrer" });
  img.addEventListener("error", () => img.replaceWith(initialAvatar(name, size)), { once: true });
  return img;
}

function chip(text, status) {
  return h("span", { class: `chip chip-${STATUS_TONE[status] ?? "plain"}` }, text);
}

function notice(text, tone = "") {
  return h("div", { class: `notice ${tone ? `notice-${tone}` : ""}` }, text);
}

function bar(ratio, cls = "") {
  const fill = h("span", { class: `bar-fill ${cls}` });
  fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  return h("span", { class: "bar", "aria-hidden": "true" }, fill);
}

function person(p, size, nameClass = "holder-name") {
  return h("span", { class: "person" }, avatar(p.avatarUrl, size, p.name), h("span", { class: nameClass }, p.name));
}

const loading = () => h("div", { class: "loading", role: "status" }, "読み込み中…");
const empty = (text) => h("div", { class: "card empty" }, text);

function toast(text) {
  toastBox.textContent = text;
  toastBox.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (toastBox.hidden = true), 4000);
}

/** Only in-site paths become links. */
function internalHref(path) {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? path : null;
}

// ───────────── API

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON error page.
  }
  if (!response.ok) throw new Error(data?.error ?? `エラーが発生しました（${response.status}）`);
  return data;
}

// ───────────── Routing

let me = { user: null, guilds: [] };

function navigate(path) {
  history.pushState(null, "", path);
  render();
  window.scrollTo(0, 0);
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(link.getAttribute("href"));
});
window.addEventListener("popstate", render);

const loginHref = () => `/auth/login?returnTo=${encodeURIComponent(location.pathname)}`;

function renderAccount() {
  replace(account);
  if (!me.user) {
    account.append(h("a", { class: "btn btn-primary", href: loginHref() }, "Discordでログイン"));
    return;
  }
  account.append(
    person(me.user, 28, "person-name"),
    h(
      "button",
      {
        class: "btn btn-ghost",
        type: "button",
        onclick: async () => {
          await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
          location.href = "/";
        },
      },
      "ログアウト",
    ),
  );
}

function render() {
  const [first, guildId, tab] = location.pathname.split("/").filter(Boolean);
  if (first === "g" && guildId) return renderGuild(guildId, tab ?? "government");
  return renderHome();
}

// ───────────── Pages

function renderHome() {
  document.title = "民主主義Bot";
  if (!me.user) {
    const features = [
      ["🗳️ 選挙", "市民が国民代表（議員）を選ぶ。Webでの秘密投票、同数はくじ。"],
      ["🏛️ 国会", "議長・首相の選出、法案の審議と記名採決、不信任・弾劾。"],
      ["🎌 内閣", "首相が大臣・裁判官を任命し、法律を施行する。"],
      ["⚖️ 裁判所", "提訴・判決・上告。確定した判決は自動で執行。"],
      ["✍️ 請願", "市民の署名が集まると法案として国会へ。"],
      ["👑 管理者派閥", "可決法案の裁可・拒否権・議会解散。すべて官報に記録。"],
    ];
    replace(app, 
      h(
        "section",
        { class: "hero" },
        h("h1", null, "Discordサーバーを、ひとつの国に。"),
        h("p", null, "管理者派閥と国民代表派閥が、選挙・国会・内閣・裁判所を通じてサーバーの運営方針を決めていきます。"),
        h("a", { class: "btn btn-primary", href: loginHref() }, "Discordでログイン"),
        h(
          "div",
          { class: "features" },
          features.map(([title, text]) => h("div", { class: "card" }, h("div", { class: "card-title" }, title), h("p", { class: "muted" }, text))),
        ),
      ),
    );
    return;
  }
  const guilds = me.guilds.length
    ? h(
        "div",
        { class: "grid grid-cards" },
        me.guilds.map((g) =>
          h(
            "a",
            { class: "card card-link", href: `/g/${g.id}`, "data-link": true },
            h("div", { class: "card-title" }, "🏛️ ", g.name),
            h("div", { class: "muted" }, `市民番号 第${g.citizenNumber}号`),
          ),
        ),
      )
    : notice("まだどのサーバーにも市民登録していません。Discordのサーバーで /citizen register を実行してください。", "warn");
  replace(app, h("h1", null, "あなたの国"), guilds);
}

async function renderGuild(guildId, tab) {
  if (!me.user) {
    replace(app, 
      h("section", { class: "hero" }, h("h1", null, "ログインが必要です"), h("p", null, "Discordアカウントでログインしてください。"), h("a", { class: "btn btn-primary", href: loginHref() }, "Discordでログイン")),
    );
    return;
  }
  const guild = me.guilds.find((g) => g.id === guildId);
  if (!guild) {
    replace(app, notice("このサーバーの市民ではありません。Discordで /citizen register を実行してから再読み込みしてください。", "warn"));
    return;
  }
  const activeTab = TABS.some(([key]) => key === tab) ? tab : "government";
  document.title = `${guild.name}｜民主主義Bot`;
  const panel = h("div", { role: "region", "aria-live": "polite" }, loading());
  replace(app, 
    h("div", { class: "guild-header" }, h("h1", null, guild.name), h("span", { class: "muted" }, `市民番号 第${guild.citizenNumber}号`)),
    h(
      "nav",
      { class: "tabs", "aria-label": "セクション" },
      TABS.map(([key, label]) =>
        h(
          "a",
          {
            class: key === activeTab ? "tab active" : "tab",
            href: key === "government" ? `/g/${guildId}` : `/g/${guildId}/${key}`,
            "data-link": true,
            "aria-current": key === activeTab ? "page" : undefined,
          },
          label,
        ),
      ),
    ),
    panel,
  );
  try {
    await VIEWS[activeTab](guildId, panel);
  } catch (error) {
    replace(panel, notice(error.message, "bad"));
  }
}

// ───────────── 政府

async function viewGovernment(guildId, root) {
  const data = await api(`/guilds/${guildId}/overview`);
  const catalog = Object.fromEntries(data.catalog.map((c) => [c.key, c]));
  const holdersOf = (key) => data.positions.filter((p) => p.key === key);

  const office = (key) => {
    const def = catalog[key];
    const holders = holdersOf(key);
    const capacity = key === "REPRESENTATIVE" ? data.guild.seats : def.capacity;
    return h(
      "div",
      { class: "office" },
      h(
        "div",
        { class: "office-label" },
        h("span", { "aria-hidden": "true" }, def.emoji),
        def.label,
        capacity && capacity > 1 ? h("span", { class: "muted small" }, `${holders.length}/${capacity}`) : null,
      ),
      holders.length
        ? h(
            "ul",
            { class: "holders" },
            holders.map((p) =>
              h(
                "li",
                { class: p.isMe ? "holder me" : "holder" },
                person(p.holder),
                p.title !== def.label ? h("span", { class: "chip" }, p.title) : null,
                p.expiresAt ? h("span", { class: "muted small" }, `任期 ${fmtDate(p.expiresAt)}まで`) : null,
              ),
            ),
          )
        : h("div", { class: "vacant" }, key === "REPRESENTATIVE" ? "議員はいません（選挙を実施してください）" : "空席"),
    );
  };

  const faction = (cls, title, sections) =>
    h("section", { class: `card faction-${cls}` }, h("h2", { class: "faction-title" }, title), sections);
  const branch = (label, keys) => [h("div", { class: "branch" }, label), keys.map(office)];

  replace(root, 
    h(
      "div",
      { class: "stats" },
      [
        ["市民", `${data.stats.citizens}名`],
        ["議席", `${data.stats.seated}/${data.guild.seats}`],
        ["進行中の議案", `${data.stats.openBills}件`],
        ["係属中の事件", `${data.stats.openCases}件`],
      ].map(([label, value]) => h("div", { class: "stat" }, h("div", { class: "muted small" }, label), h("div", { class: "stat-value" }, value))),
    ),
    h(
      "div",
      { class: "factions" },
      faction("admin", "👑 管理者派閥", branch("元首・管理官", ["SOVEREIGN", "ADMINISTRATOR"])),
      faction("representative", "🏛️ 国民代表派閥", [
        branch("立法府（国会）", ["SPEAKER", "VICE_SPEAKER", "REPRESENTATIVE", "AIDE"]),
        branch("行政府（内閣）", ["PRIME_MINISTER", "DEPUTY_PRIME_MINISTER", "CHIEF_CABINET_SECRETARY", "MINISTER"]),
      ]),
      faction("neutral", "⚖️ 独立機関", [
        branch("司法府（裁判所）", ["CHIEF_JUSTICE", "JUDGE"]),
        branch("選挙管理委員会", ["ELECTION_COMMISSIONER", "ELECTION_COMMISSION_MEMBER"]),
      ]),
    ),
    h(
      "details",
      { class: "card catalog" },
      h("summary", null, "役職一覧（序列・選ばれ方・権限）"),
      h(
        "ol",
        null,
        data.catalog.map((c) =>
          h(
            "li",
            null,
            h("strong", null, `${c.emoji} ${c.label}`),
            " ",
            h("span", { class: "chip" }, c.factionLabel),
            " ",
            c.branchLabel !== c.factionLabel ? h("span", { class: "chip" }, c.branchLabel) : null,
            h("div", { class: "muted small" }, `選出: ${c.selection}`),
            h("ul", null, c.powers.map((power) => h("li", { class: "small" }, power))),
          ),
        ),
      ),
    ),
  );
}

// ───────────── 選挙

async function viewElection(guildId, root) {
  const data = await api(`/guilds/${guildId}/election`);
  const reload = () => viewElection(guildId, root);
  replace(root, 
    data.current ? currentElection(guildId, data.current, data.viewer, reload) : empty("現在、進行中の選挙はありません。"),
    data.past.length ? h("h2", null, "過去の選挙") : null,
    data.past.map(pastElection),
  );
}

function currentElection(guildId, e, viewer, reload) {
  const phase = e.status === "REGISTRATION" ? 1 : 2;
  const steps = [
    ["告示", e.createdAt],
    ["立候補締切", e.registrationEndsAt],
    ["投票締切", e.votingEndsAt],
  ];
  const card = h(
    "section",
    { class: "card" },
    h("div", { class: "card-head" }, h("h2", null, e.title), chip(e.kindLabel), chip(e.statusLabel, e.status)),
    e.description ? richText(e.description, "p") : null,
    h(
      "ol",
      { class: "timeline", "aria-label": "日程" },
      steps.map(([label, iso], index) =>
        h("li", { class: index < phase ? "done" : index === phase ? "current" : "" }, h("strong", null, label), h("time", { datetime: iso }, fmt(iso))),
      ),
    ),
    h(
      "p",
      { class: "muted" },
      `定数 ${e.seats}名 ・ 候補者 ${e.candidates.length}名`,
      e.status === "VOTING" ? ` ・ 投票者 ${e.turnout}名（得票は開票まで非公開）` : "",
    ),
  );

  if (e.status === "REGISTRATION") {
    card.append(notice("立候補を受け付けています。Discordで /election candidacy を実行すると立候補できます。投票は立候補締切の後に始まります。"));
  } else if (viewer?.voted) {
    card.append(notice("✅ 投票済みです。秘密投票のため、あなたの投票先は記録されていません。", "ok"));
  } else if (viewer && !viewer.onRoll) {
    card.append(notice("選挙人名簿に登録されていないため投票できません（立候補締切までに市民登録した市民が対象です）。", "warn"));
  } else if (viewer?.canVote) {
    card.append(h("p", null, "候補者を1人選んで投票してください。", h("span", { class: "muted small" }, ` 締切: ${fmt(e.votingEndsAt)}（${relative(e.votingEndsAt)}）`)));
  }

  const canVote = Boolean(viewer?.canVote);
  const list = h("div", { class: "candidates", role: canVote ? "radiogroup" : "list", "aria-label": "候補者" });
  const voteButton = h("button", { class: "btn btn-primary", type: "button", disabled: true }, "この候補者に投票する");
  const confirmBox = h("div", { class: "confirm", hidden: true });
  let selected = null;

  for (const candidate of e.candidates) {
    const item = h(
      canVote ? "button" : "div",
      canVote ? { class: "candidate", type: "button", role: "radio", "aria-checked": "false" } : { class: "candidate", role: "listitem" },
      avatar(candidate.avatarUrl, 48, candidate.name),
      h(
        "div",
        null,
        h("div", { class: "candidate-name" }, candidate.name),
        candidate.manifesto ? richText(candidate.manifesto, "div", "rich muted small") : h("div", { class: "muted small" }, "公約の登録はありません"),
      ),
    );
    if (canVote) {
      item.addEventListener("click", () => {
        selected = candidate;
        for (const el of list.children) el.setAttribute("aria-checked", String(el === item));
        voteButton.disabled = false;
        confirmBox.hidden = true;
      });
    }
    list.append(item);
  }
  if (e.candidates.length === 0) list.append(h("div", { class: "muted" }, "まだ候補者はいません。"));
  card.append(list);

  if (canVote) {
    voteButton.addEventListener("click", () => {
      const submit = h("button", { class: "btn btn-primary", type: "button" }, "投票する");
      const status = h("div");
      submit.addEventListener("click", async () => {
        submit.disabled = true;
        try {
          await api(`/guilds/${guildId}/elections/${e.id}/ballot`, { method: "POST", body: JSON.stringify({ candidateId: selected.id }) });
          toast("投票しました。ご参加ありがとうございます。");
          await reload();
        } catch (error) {
          replace(status, notice(error.message, "bad"));
          submit.disabled = false;
        }
      });
      replace(confirmBox, 
        h("p", null, `「${selected.name}」に投票します。投票後に変更することはできません。よろしいですか？`),
        h("div", { class: "row" }, submit, h("button", { class: "btn btn-ghost", type: "button", onclick: () => (confirmBox.hidden = true) }, "やめる")),
        status,
      );
      confirmBox.hidden = false;
      submit.focus();
    });
    card.append(h("div", { class: "vote-actions" }, voteButton), confirmBox);
  }
  return card;
}

function pastElection(e) {
  const max = Math.max(1, ...e.candidates.map((c) => c.voteCount));
  return h(
    "section",
    { class: "card" },
    h("div", { class: "card-head" }, h("h3", null, e.title), chip(e.kindLabel), chip(e.statusLabel, e.status)),
    e.status === "CANCELLED"
      ? h("p", { class: "muted" }, `中止: ${e.cancelReason ?? "記載なし"}`)
      : [
          h("p", { class: "muted small" }, `投票者 ${e.turnout}名 ・ 定数 ${e.seats}名${e.decidedAt ? ` ・ ${fmt(e.decidedAt)} 確定` : ""}`),
          h(
            "ol",
            { class: "results" },
            e.candidates.map((c) =>
              h(
                "li",
                { class: c.elected ? "result elected" : "result" },
                avatar(c.avatarUrl, 28, c.name),
                h("span", { class: "result-name" }, c.name),
                bar(c.voteCount / max),
                h("span", { class: "result-votes" }, `${c.voteCount}票`),
                h("span", { class: "result-badge" }, c.elected ? chip("当選", "COMPLETED") : h("span", { class: "muted small" }, "落選")),
              ),
            ),
          ),
          e.lotteryUsed ? h("p", { class: "muted small" }, "※最下位当選者が得票同数のため、くじで当選人を決定しました。") : null,
        ],
  );
}

// ───────────── 国会

const OPEN_BILLS = new Set(["DELIBERATION", "VOTING", "PASSED", "VETOED"]);
const ENACTED_BILLS = new Set(["ENACTED", "IMPLEMENTED"]);

async function viewParliament(guildId, root) {
  const { bills } = await api(`/guilds/${guildId}/bills`);
  const filters = [
    ["進行中", (b) => OPEN_BILLS.has(b.status)],
    ["成立", (b) => ENACTED_BILLS.has(b.status)],
    ["すべて", () => true],
  ];
  const list = h("div");
  const filterBar = h("div", { class: "filters", role: "group", "aria-label": "絞り込み" });
  const show = (index) => {
    for (const [i, button] of [...filterBar.children].entries()) button.setAttribute("aria-pressed", String(i === index));
    const shown = bills.filter(filters[index][1]);
    replace(list, ...(shown.length ? shown.map((b) => billItem(guildId, b)) : [empty("該当する法案はありません。")]));
  };
  filters.forEach(([label], index) => filterBar.append(h("button", { class: "filter", type: "button", onclick: () => show(index) }, label)));
  replace(root, 
    notice("法案は議員・閣僚が提出し、議長が採決を開始します。可決された法律案は管理者派閥の裁可（または期限経過）で成立します。"),
    filterBar,
    list,
  );
  show(bills.some((b) => OPEN_BILLS.has(b.status)) ? 0 : 2);
}

function billItem(guildId, b) {
  const body = h("div", { class: "item-body" }, loading());
  const item = h(
    "details",
    { class: "card item" },
    h(
      "summary",
      null,
      h("span", { class: "card-head" }, h("span", { class: "item-title" }, `第${b.number}号「${b.title}」`), chip(b.kindLabel), chip(b.statusLabel, b.status)),
      h(
        "span",
        { class: "item-meta" },
        h("span", null, `${b.originLabel}・提出者 ${b.proposer.name}`),
        b.target ? h("span", null, `対象: ${b.target.name}`) : null,
        h("span", null, `可決要件: ${b.majorityLabel}${b.round === 2 ? "（再議決）" : ""}`),
        b.status === "VOTING" && b.votingEndsAt ? h("span", null, "採決締切: ", deadline(b.votingEndsAt)) : null,
        b.status === "PASSED" && b.sanctionDeadline ? h("span", null, "裁可期限: ", deadline(b.sanctionDeadline)) : null,
      ),
    ),
    body,
  );
  let loaded = false;
  item.addEventListener("toggle", async () => {
    if (!item.open || loaded) return;
    loaded = true;
    try {
      const d = await api(`/guilds/${guildId}/bills/${b.number}`);
      const t = d.tally;
      const voters = (choice) => d.votes.filter((v) => v.choice === choice).map((v) => v.name).join("、") || "なし";
      replace(body, 
        richText(d.content),
        d.votes.length
          ? [
              h("div", { class: "section-label" }, "採決（記名投票）"),
              h(
                "div",
                { class: "tally" },
                h("span", null, "賛成"),
                bar(t.participants ? t.for / t.participants : 0),
                h("span", null, t.for),
                h("span", null, "反対"),
                bar(t.participants ? t.against / t.participants : 0, "against"),
                h("span", null, t.against),
                h("span", null, "棄権"),
                bar(t.participants ? t.abstain / t.participants : 0, "abstain"),
                h("span", null, t.abstain),
              ),
              h("div", { class: "muted small" }, `在籍 ${t.seated}名・定足数 ${t.quorum}名`),
              h(
                "div",
                { class: "voters" },
                h("div", null, h("strong", null, "賛成: "), voters("FOR")),
                h("div", null, h("strong", null, "反対: "), voters("AGAINST")),
                h("div", null, h("strong", null, "棄権: "), voters("ABSTAIN")),
              ),
            ]
          : null,
        d.outcomeNote ? notice(`結果: ${d.outcomeNote}`) : null,
        d.vetoReason ? notice(`拒否権の理由: ${d.vetoReason}`, "bad") : null,
        d.implementedNote ? notice(`施行: ${d.implementedNote}`, "ok") : null,
        d.petitionNumber ? h("p", { class: "muted small" }, `請願 第${d.petitionNumber}号から送付された法案です。`) : null,
      );
    } catch (error) {
      replace(body, notice(error.message, "bad"));
    }
  });
  return item;
}

// ───────────── 裁判所

async function viewCourt(guildId, root) {
  const { cases } = await api(`/guilds/${guildId}/cases`);
  replace(root, 
    notice("だれでも /court file で訴えを起こせます。判決に不服があれば上告期間内に /court appeal で上告できます。"),
    cases.length ? cases.map((c) => caseItem(guildId, c)) : empty("事件はまだありません。"),
  );
}

function caseItem(guildId, c) {
  const body = h("div", { class: "item-body" }, loading());
  const item = h(
    "details",
    { class: "card item" },
    h(
      "summary",
      null,
      h("span", { class: "card-head" }, h("span", { class: "item-title" }, `事件 第${c.number}号「${c.title}」`), chip(c.statusLabel, c.status)),
      h(
        "span",
        { class: "item-meta" },
        h("span", null, `原告 ${c.plaintiff.name} 対 被告 ${c.defendant.name}`),
        h("span", null, `担当: ${c.judge ? c.judge.name : "未定"}`),
        c.resultLabel ? h("span", null, `判決: ${c.resultLabel}（制裁: ${c.penaltyLabel ?? "なし"}）`) : null,
        h("span", null, `提訴 ${fmtDate(c.filedAt)}`),
      ),
    ),
    body,
  );
  let loaded = false;
  item.addEventListener("toggle", async () => {
    if (!item.open || loaded) return;
    loaded = true;
    try {
      const d = await api(`/guilds/${guildId}/cases/${c.number}`);
      replace(body, 
        h("div", { class: "section-label" }, "訴えの内容"),
        richText(d.claim),
        d.defense ? [h("div", { class: "section-label" }, "答弁"), richText(d.defense)] : null,
        d.firstInstance
          ? [
              h("div", { class: "section-label" }, `判決: ${d.firstInstance.resultLabel}（制裁: ${d.firstInstance.penaltyLabel ?? "なし"}）`),
              richText(d.firstInstance.ruling),
            ]
          : null,
        d.appealDeadline ? h("p", { class: "muted small" }, "上告期限: ", deadline(d.appealDeadline)) : null,
        d.appeal ? [h("div", { class: "section-label" }, `上告${d.appeal.appellant ? `（${d.appeal.appellant.name}）` : ""}`), richText(d.appeal.reason)] : null,
        d.finalRuling
          ? [
              h("div", { class: "section-label" }, `上告審判決: ${d.finalRuling.resultLabel}（制裁: ${d.finalRuling.penaltyLabel ?? "なし"}）`),
              richText(d.finalRuling.ruling),
            ]
          : null,
        d.penalty ? notice(`執行: ${d.penalty.statusLabel}${d.penalty.note ? `（${d.penalty.note}）` : ""}`) : null,
      );
    } catch (error) {
      replace(body, notice(error.message, "bad"));
    }
  });
  return item;
}

// ───────────── 請願

async function viewPetitions(guildId, root) {
  const { petitions, threshold } = await api(`/guilds/${guildId}/petitions`);
  const reload = () => viewPetitions(guildId, root);
  replace(root, 
    notice(`請願は ${threshold}筆 の署名が集まると法案として国会に送られます。Discordの /petition create で作成できます。`),
    petitions.length ? petitions.map((p) => petitionCard(guildId, p, threshold, reload)) : empty("請願はまだありません。"),
  );
}

function petitionCard(guildId, p, threshold, reload) {
  const canSign = p.status === "OPEN" && !p.signedByMe;
  const status = h("div");
  const sign = canSign ? h("button", { class: "btn btn-primary", type: "button" }, "署名する") : null;
  sign?.addEventListener("click", async () => {
    sign.disabled = true;
    try {
      const result = await api(`/guilds/${guildId}/petitions/${p.number}/sign`, { method: "POST", body: "{}" });
      toast(result.submitted ? "署名しました。必要数に達したため国会へ送付されました！" : "署名しました。");
      await reload();
    } catch (error) {
      replace(status, notice(error.message, "bad"));
      sign.disabled = false;
    }
  });
  return h(
    "section",
    { class: "card" },
    h("div", { class: "card-head" }, h("h3", null, `第${p.number}号「${p.title}」`), chip(p.statusLabel, p.status)),
    richText(p.content),
    h(
      "div",
      { class: "progress" },
      bar(p.signatureCount / threshold),
      h("span", { class: "small" }, `${p.signatureCount}/${threshold}筆`),
    ),
    h(
      "div",
      { class: "item-meta" },
      h("span", null, `提出者 ${p.creator.name}`),
      p.status === "OPEN" ? h("span", null, "締切: ", deadline(p.expiresAt)) : null,
      p.billNumber ? h("span", null, `第${p.billNumber}号議案として送付`) : null,
      p.signedByMe ? h("span", null, "✅ 署名済み") : null,
    ),
    sign ? h("div", { class: "row" }, sign) : null,
    status,
  );
}

// ───────────── 官報

async function viewGazette(guildId, root) {
  const list = h("div");
  const more = h("button", { class: "btn btn-ghost", type: "button" }, "さらに読み込む");
  let oldest = null;
  const load = async () => {
    more.disabled = true;
    const { entries } = await api(`/guilds/${guildId}/gazette${oldest ? `?before=${oldest}` : ""}`);
    for (const entry of entries) list.append(gazetteEntry(entry));
    if (entries.length) oldest = entries[entries.length - 1].number;
    more.hidden = entries.length < 30;
    more.disabled = false;
    if (!list.children.length) list.append(empty("官報の記録はまだありません。"));
  };
  more.addEventListener("click", () => load().catch((error) => toast(error.message)));
  replace(root, h("p", { class: "muted" }, "官報は、選挙・人事・立法・司法・管理者の操作など、すべての公式行為の記録です。"), list, h("div", { class: "row" }, more));
  await load();
}

function gazetteEntry(e) {
  const href = internalHref(e.linkPath);
  return h(
    "article",
    { class: "card" },
    h("div", { class: "entry-head" }, h("span", { class: "entry-number" }, `官報 第${e.number}号`), h("time", { datetime: e.createdAt }, fmt(e.createdAt)), chip(e.categoryLabel)),
    h("h3", null, e.title),
    richText(e.body),
    href ? h("p", null, h("a", { href, "data-link": true }, "関連ページへ →")) : null,
  );
}

const VIEWS = {
  government: viewGovernment,
  election: viewElection,
  parliament: viewParliament,
  court: viewCourt,
  petitions: viewPetitions,
  gazette: viewGazette,
};

// ───────────── Start

(async () => {
  try {
    me = await api("/me");
  } catch {
    me = { user: null, guilds: [] };
  }
  renderAccount();
  render();
})();
