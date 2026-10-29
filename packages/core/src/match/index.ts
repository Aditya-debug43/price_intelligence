export { analyseCatalogue, fitmentYears, mineColourVocab, type Corpus, type CorpusStats } from './corpus.ts';
export {
  COMPANION_NOUNS, SPEC_HARDNESS, SPEC_LABEL, bundleMarkersIn, buildDossier, kindOf, parseCodeTokens, parseExclusions, parsePackCount, parseSpecs, parseYears,
  type Dossier, type DossierInput, type FactSource, type Spec, type SpecKey, type YearMentions,
} from './dossier.ts';
export { DEFAULT_CANDIDATE_OPTIONS, buildCandidateIndex, retrieveCandidates, type CandidateIndex, type CandidateOptions, type Retrieved } from './candidates.ts';
export { evaluatePair, type PairEvaluation } from './evidence.ts';
export { candidateRecall, cohensKappa, evaluate, expectedCalibrationError, prf, wilsonLower, wilsonUpper, type EvaluationReport, type LabelledPair, type Prediction, type Prf } from './metrics.ts';
export { DEFAULT_ENGINE_OPTIONS, ENGINE_VERSION, dossierHash, hashText, runEngine, type EngineOptions, type EngineResult, type EngineStats, type Suggestion } from './engine.ts';
