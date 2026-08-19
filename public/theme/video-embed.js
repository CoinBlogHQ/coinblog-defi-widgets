/* Coin Blog - lazy video embeds (YouTube facade click-to-load, keyboard a11y).
   SSR inlines the same CSS; this file also injects it as a safety net for
   client-rendered pages. Self-guarded so it initializes only once. */
(function () {
	if (window.__cbVideoReady) return;
	window.__cbVideoReady = true;

	var CSS = ".cb-video{position:relative;width:100%;max-width:820px;margin:1.5em auto;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:#000;box-shadow:0 6px 24px rgba(0,0,0,.18)}.cb-video iframe,.cb-video video,.cb-video .cb-video-thumb{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}.cb-video .cb-video-thumb{object-fit:cover}.cb-video video{object-fit:contain}.cb-video-facade{cursor:pointer}.cb-video-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:72px;height:50px;border-radius:14px;background:rgba(20,20,20,.72);transition:background .15s ease,transform .15s ease;pointer-events:none}.cb-video-play::after{content:'';position:absolute;left:52%;top:50%;transform:translate(-50%,-50%);border-style:solid;border-width:11px 0 11px 18px;border-color:transparent transparent transparent #fff}.cb-video-facade:hover .cb-video-play,.cb-video-facade:focus-visible .cb-video-play{background:#e50914;transform:translate(-50%,-50%) scale(1.06)}.cb-video-facade:focus-visible{outline:3px solid #2563eb;outline-offset:2px}";

	if (!document.getElementById('cb-video-css')) {
		var st = document.createElement('style');
		st.id = 'cb-video-css';
		st.textContent = CSS;
		(document.head || document.documentElement).appendChild(st);
	}

	function load(el) {
		if (!el || el.classList.contains('cb-video-on')) return;
		var yt = el.getAttribute('data-yt');
		var vimeo = el.getAttribute('data-vimeo');
		var src = '';
		if (yt) src = 'https://www.youtube-nocookie.com/embed/' + yt + '?autoplay=1&rel=0&modestbranding=1';
		else if (vimeo) src = 'https://player.vimeo.com/video/' + vimeo + '?autoplay=1';
		else return;
		var f = document.createElement('iframe');
		f.className = 'cb-video-frame';
		f.setAttribute('src', src);
		f.setAttribute('title', el.getAttribute('data-title') || 'Video');
		f.setAttribute('frameborder', '0');
		f.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
		f.setAttribute('allowfullscreen', '');
		f.setAttribute('loading', 'eager');
		el.innerHTML = '';
		el.appendChild(f);
		el.classList.add('cb-video-on');
	}

	function facadeFrom(target) {
		return target && target.closest ? target.closest('.cb-video-facade') : null;
	}

	document.addEventListener('click', function (e) {
		load(facadeFrom(e.target));
	});
	document.addEventListener('keydown', function (e) {
		if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
		var el = facadeFrom(e.target);
		if (el) {
			e.preventDefault();
			load(el);
		}
	});
})();
