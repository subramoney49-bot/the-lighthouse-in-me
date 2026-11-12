/* Anonymous, cookie-free website stats for reshma.co.za.
   Counts page views, visits, where visitors came from, campaign links (?c=name)
   and shop steps. No cookies, no personal details: a random visit id lives only
   in this browser tab's session storage and disappears when the tab closes. */
(function () {
  if (/bot|crawl|spider|slurp|preview|lighthouse|headless/i.test(navigator.userAgent)) return;
  var ss = {
    get: function (k) { try { return sessionStorage.getItem(k) || ""; } catch (e) { return ""; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
  };

  function classify(ref, ua, utm) {
    var u = (utm || "").toLowerCase();
    if (u) {
      if (/tiktok/.test(u)) return "TikTok";
      if (/facebook|fb/.test(u)) return "Facebook";
      if (/insta|ig/.test(u)) return "Instagram";
      if (/whats|wa/.test(u)) return "WhatsApp";
      if (/google/.test(u)) return "Google";
      if (/mail|newsletter/.test(u)) return "Email";
      return u.charAt(0).toUpperCase() + u.slice(1, 30);
    }
    var h = "";
    try { h = ref ? new URL(ref).hostname.toLowerCase() : ""; } catch (e) {}
    if (h && h === location.hostname) h = "";
    if (/tiktok/.test(h)) return "TikTok";
    if (/facebook|fb\.|fb\.me|messenger/.test(h)) return "Facebook";
    if (/instagram/.test(h)) return "Instagram";
    if (/whatsapp|wa\.me/.test(h)) return "WhatsApp";
    if (/google\./.test(h)) return "Google";
    if (/bing|yahoo|duckduckgo|ecosia/.test(h)) return "Other search";
    if (/linkedin|lnkd/.test(h)) return "LinkedIn";
    if (/^t\.co$|twitter|^x\.com/.test(h)) return "X (Twitter)";
    if (/youtube|youtu\.be/.test(h)) return "YouTube";
    if (/mail/.test(h)) return "Email";
    if (h) return "Other websites";
    // No referrer: look for in-app browsers
    if (/BytedanceWebview|musical_ly|TikTok/i.test(ua)) return "TikTok";
    if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "Facebook";
    if (/Instagram/i.test(ua)) return "Instagram";
    if (/WhatsApp/i.test(ua)) return "WhatsApp";
    return "Direct or messaging app";
  }

  var sid = ss.get("lh_sid"), isNew = !sid;
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    ss.set("lh_sid", sid);
  }
  var q = new URLSearchParams(location.search);
  var camp = (q.get("c") || q.get("utm_campaign") || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  if (isNew) {
    ss.set("lh_src", classify(document.referrer, navigator.userAgent, q.get("utm_source")));
    ss.set("lh_c", camp);
  } else if (camp && !ss.get("lh_c")) {
    ss.set("lh_c", camp);
  }
  var src = ss.get("lh_src") || "Direct or messaging app";
  var c = ss.get("lh_c");

  function send(d) {
    d.s = src; d.c = c;
    try {
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(d),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }

  send({ t: "view", p: location.pathname, n: isNew ? 1 : 0 });

  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest && e.target.closest("[data-buy]");
    if (b) send({ t: "buy", product: b.getAttribute("data-buy") });
  }, true);

  window.LH_TRACK = { source: src, campaign: c, send: send };
})();
