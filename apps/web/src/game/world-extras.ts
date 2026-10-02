/** Extras beyond the lead-owned `World` contract (the grid overlay toggle). */
export interface WorldExtras {
  setGridVisible(visible: boolean): void;
  readonly gridVisible: boolean;
}
