// Unlocks a.bin: PBKDF2-SHA256 derives a key from the password, which unwraps the content key
// (AES-GCM); the content key decrypts the page bundle, which is then mounted in this document.
(() => {
  const SAVED = "u.k";
  const from64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const to64 = (u) => btoa(String.fromCharCode(...u));
  const store = (() => { try { sessionStorage.getItem("x"); return sessionStorage; } catch { return null; } })();
  let payload = null;

  async function load() {
    if (!payload) {
      const r = await fetch("a.bin", { cache: "no-store" });
      if (!r.ok) throw new Error(`a.bin: HTTP ${r.status}`);
      payload = await r.json();
    }
    return payload;
  }

  async function unwrap(password, p) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const kek = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: from64(p.kdf.salt), iterations: p.kdf.iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: from64(p.wk.iv) }, kek, from64(p.wk.ct)));
  }

  async function mount(raw) {
    const p = await load();
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const b = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: from64(p.iv) }, key, from64(p.ct))));
    document.title = b.title;
    document.querySelector("link[rel=icon]").href = b.icon;
    document.getElementById("lock-style").remove();
    const style = document.createElement("style");
    style.textContent = b.css;
    document.head.append(style);
    document.body.innerHTML = b.body;
    for (const s of b.scripts) {
      await new Promise((resolve, reject) => {
        const el = document.createElement("script");
        if (s.module) el.type = "module";
        el.src = URL.createObjectURL(new Blob([s.code], { type: "text/javascript" }));
        el.onload = resolve;
        el.onerror = reject;
        document.body.append(el);
      });
    }
  }

  function showForm() {
    const form = document.getElementById("lock");
    const msg = document.getElementById("msg");
    form.hidden = false;
    document.getElementById("pw").focus();
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      msg.textContent = "";
      let raw;
      try {
        raw = await unwrap(document.getElementById("pw").value, await load());
      } catch (e) {
        msg.textContent = e.message.startsWith("a.bin") ? "The page could not be loaded." : "Incorrect password.";
        button.disabled = false;
        return;
      }
      if (document.getElementById("keep").checked) store?.setItem(SAVED, to64(raw));
      try { await mount(raw); } catch { msg.textContent = "The page could not be opened."; button.disabled = false; }
    };
  }

  const saved = store?.getItem(SAVED);
  if (saved) mount(from64(saved)).catch(() => { store.removeItem(SAVED); location.reload(); });
  else showForm();
})();
