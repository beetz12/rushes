import { requireDecodedAlignment } from './media-coordinates.mjs';

// Qualification is about a known input A/V relationship, not a wall-clock epoch.
// Relative shape and playable zero-origin exports cannot prove that relationship.
export function productSyncSourceVerdict(mode, qualification) {
  if (mode === 'native-reference') {
    if (qualification?.qualified !== true || qualification?.sourceKind !== 'measured-supplied-track-reference-timeline'
      || qualification?.sameRun !== true || qualification?.sameWindow !== true || !Number.isFinite(qualification?.timeOrigin)
      || qualification?.wholeExtentCovered !== true || qualification?.joinsWithin250ms !== true
      || qualification?.converter?.qualified !== true || qualification?.converter?.arrivalTimeUsed !== false
      || qualification?.converter?.recordedAVPhaseUsed !== false
      || qualification?.decoded?.timeBasis !== 'same-Window supplied-track reference timestamps')
      return { eligible: false, reason: 'Independent same-run supplied-reference content/clock/coverage witness is missing' };
    try { requireDecodedAlignment(qualification.decoded.points); }
    catch (error) { return { eligible: false, reason: String(error) }; }
    return { eligible: true, reason: 'Measured generated supplied-track reference phase qualifies within100ms including uncertainty; no physical timing claim' };
  }
  if (mode !== 'container') return { eligible: false,
    reason: 'Native-feedback qualifies relative emitted shape only; input A/V phase remains unknown' };
  if (qualification?.qualified !== true || qualification?.sourceKind !== 'encoded-common-content-timeline'
    || qualification?.decoded?.timeBasis !== 'same-container presentation timestamps')
    return { eligible: false, reason: 'Independent common-content source qualification is missing' };
  try { requireDecodedAlignment(qualification.decoded.points); }
  catch (error) { return { eligible: false, reason: String(error) }; }
  return { eligible: true, reason: 'Independent decoded common-content source phase qualifies within100ms including uncertainty' };
}

export function requireProductSyncSource(mode, qualification) {
  const verdict = productSyncSourceVerdict(mode, qualification);
  if (!verdict.eligible) throw new Error(`PRODUCT_SYNC_SOURCE_UNQUALIFIED: ${verdict.reason}`);
  return verdict;
}
