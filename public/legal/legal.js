(() => {
  // src/client/legal.ts
  var links = new Map([...document.querySelectorAll('.toc a[href^="#"]')].map((a) => [
    a.getAttribute("href").slice(1),
    a
  ]));
  var sections = [...document.querySelectorAll(".doc section[id]")];
  function mark(id) {
    for (const [key, a] of links)
      a.setAttribute("aria-current", key === id ? "true" : "false");
    const active = links.get(id);
    if (active)
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  if ("IntersectionObserver" in window && sections.length) {
    const seen = new Map;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries)
        seen.set(e.target.id, e.isIntersecting);
      const current = sections.find((s) => seen.get(s.id)) || sections.filter((s) => s.getBoundingClientRect().top < 0).pop();
      if (current)
        mark(current.id);
    }, { rootMargin: "-15% 0px -70% 0px", threshold: 0 });
    sections.forEach((s) => io.observe(s));
    mark(sections[0].id);
  }
})();
