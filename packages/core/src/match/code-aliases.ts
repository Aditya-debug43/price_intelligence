/**
 * Standard lamp designations that name the SAME lamp (ECE R37 / SAE): each row is one lamp written several ways. This is the VERIFIED table. It is separate from the aliases the software
 * LEARNS from the catalogue (codes that merely appear together on listings): a learned family can help find a candidate, only a verified alias can be evidence that two listings name one lamp.
 * H8, H9 and H11 are deliberately absent: they differ in connector and power.
 */
export const VERIFIED_CODE_ALIASES: readonly (readonly string[])[] = [
  ['H4', '9003', 'HB2'], ['9005', 'HB3'], ['9006', 'HB4'], ['9004', 'HB1'], ['H10', '9145'], ['9011', 'HIR1'], ['9012', 'HIR2'],
  ['1156', 'P21W'], ['1157', 'P21/5W'], ['7440', 'W21W'], ['7443', 'W21/5W'], ['3156', 'P27W'], ['3157', 'P27/7W'], ['194', '168', '2825', 'W5W'],
];
