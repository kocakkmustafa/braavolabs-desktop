/* Blocking, self-hosted prepaint preference; must match src/theme.ts. */
(() => {
  let choice = "system";
  try {
    const saved = localStorage.getItem("bv.prefs.theme");
    if (["system", "light", "dark"].includes(saved)) choice = saved;
  } catch { /* blocked storage: use system appearance */ }
  const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const root = document.documentElement;
  root.dataset.themePreference = choice;
  root.dataset.theme = choice === "system" ? dark ? "dark" : "light" : choice;
  root.style.colorScheme = root.dataset.theme;
})();
