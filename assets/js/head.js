/* Runs before first paint: marks that JS is available so reveal
   animations only initialise for capable clients (avoids FOUC). */
document.documentElement.classList.add("js");
