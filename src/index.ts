
const main = () => {
    console.log("Extension loaded");
    removeDirt();
}

function removeDirt() {

}


if (document.readyState === 'complete' || document.readyState === 'interactive') {
    // Page is already loaded
    main();
} else {
    // Wait for the page to be fully loaded
    window.addEventListener('load', main);
}