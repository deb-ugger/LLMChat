/** A select opens from its control, not from the surrounding caption or blank label area. */
export function installControlLabelBehavior() {
  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const label=event.target.closest("label");
    if(!label||event.target.closest("input,select,button,a,[role=combobox],[contenteditable=true]"))return;
    const control=label.control||label.querySelector("select,[role=combobox]");
    if(control?.matches("select,[role=combobox]"))event.preventDefault();
  },true);
}
