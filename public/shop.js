(() => {
  // Mobile menu
  const t = document.querySelector(".menu-toggle"), m = document.querySelector(".menu");
  if (t && m) {
    t.addEventListener("click", () => { const o = m.classList.toggle("open"); t.setAttribute("aria-expanded", o); });
    m.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => m.classList.remove("open")));
  }

  const PRODUCTS = {
    ebook: { title: "Ebook · R199", summary: "Read the full book online with your personal access code." },
    paperback: { title: "Paperback · R380", summary: "R380 including PostNet to PostNet delivery to your nearest branch, with the free 7-Day Journal App." },
    collect: { title: "Paperback, collect · R310", summary: "The printed book with no delivery: we'll contact you to arrange collection. Includes the free 7-Day Journal App." },
    test: { title: "Website test · R5", summary: "A R5 payment to check the checkout works. Only you will see this." },
  };
  const dlg = document.getElementById("checkout");
  const form = document.getElementById("orderForm");
  if (!dlg || !form) return;
  const err = document.getElementById("formError");
  const payBtn = document.getElementById("payBtn");
  const delivery = document.getElementById("deliveryFields");
  let current = "ebook";

  function open(product) {
    current = PRODUCTS[product] ? product : "ebook";
    document.getElementById("modalTitle").textContent = PRODUCTS[current].title;
    document.getElementById("modalSummary").textContent = PRODUCTS[current].summary;
    const needsDelivery = current === "paperback";
    const isCollect = current === "collect";
    delivery.hidden = !(needsDelivery || isCollect);
    delivery.querySelectorAll("input").forEach((i) => (i.required = needsDelivery));
    document.getElementById("cell").required = needsDelivery || isCollect;
    document.getElementById("postnetField").hidden = isCollect;
    document.getElementById("cellHint").textContent = isCollect
      ? "We'll contact you on this number to arrange collection."
      : "PostNet will contact you on this number when your book arrives.";
    document.getElementById("emailHint").textContent = needsDelivery || isCollect
      ? "Your order confirmation and journal app code will be sent here."
      : "Your access code will be sent here.";
    err.textContent = "";
    dlg.showModal();
    document.getElementById("firstName").focus();
  }

  document.querySelectorAll("[data-buy]").forEach((b) => b.addEventListener("click", () => open(b.dataset.buy)));
  document.getElementById("closeBtn").addEventListener("click", () => dlg.close());

  const params = new URLSearchParams(location.search);
  if (params.has("cancelled")) {
    document.getElementById("cancelled").hidden = false;
    document.getElementById("buy")?.scrollIntoView();
  }
  if (params.get("buy")) open(params.get("buy"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const data = Object.fromEntries(new FormData(form));
    data.product = current;
    payBtn.disabled = true;
    payBtn.textContent = "Please wait…";
    try {
      const res = await fetch("/api/shop/create-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || "Something went wrong. Please try again.");
      const pf = document.createElement("form");
      pf.method = "POST";
      pf.action = out.action;
      for (const [k, v] of Object.entries(out.fields)) {
        const i = document.createElement("input");
        i.type = "hidden"; i.name = k; i.value = v;
        pf.appendChild(i);
      }
      document.body.appendChild(pf);
      pf.submit();
    } catch (e2) {
      err.textContent = e2.message;
      payBtn.disabled = false;
      payBtn.textContent = "Continue to PayFast";
    }
  });

})();
