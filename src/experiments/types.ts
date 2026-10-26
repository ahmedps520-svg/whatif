import type { ParamValues } from '../engine/types';

export type CategoryId = 'physics' | 'space' | 'earth' | 'biology' | 'civilization' | 'technology';

export type Difficulty = 'beginner' | 'intermediate' | 'advanced';

/** An implemented experiment: a configured question answered by a real model. */
export interface ExperimentDef {
  /** URL slug, unique across the catalog. */
  id: string;
  /** The question, e.g. "What if Earth's gravity doubled?" */
  title: string;
  category: CategoryId;
  modelId: string;
  /** One or two sentences: what the user will explore. */
  description: string;
  difficulty: Difficulty;
  /** Rough minutes for a user to run and inspect the experiment. */
  estMinutes: number;
  /** Experimental parameter values (merged over model defaults). */
  params: Partial<ParamValues>;
  /**
   * Baseline parameter values for comparison (merged over model defaults).
   * Omit when the experiment has no meaningful baseline (e.g. a free sandbox),
   * or when the model already compares internally (set `baselineInternal`).
   */
  baseline?: Partial<ParamValues>;
  baselineLabel?: string;
  /** The model itself shows baseline vs experiment side by side. */
  baselineInternal?: boolean;
  /** Assumptions specific to this experiment's interpretation of the question. */
  assumptions?: string[];
  /** Subjects and keywords for search. */
  tags: string[];
  /** Short teaser used when featured on the dashboard. */
  featured?: string;
  /** Ids of experiments to suggest afterwards. */
  followUps?: string[];
}

/** A scenario listed in the library that is not simulated yet. */
export interface PlannedExperiment {
  id: string;
  title: string;
  category: CategoryId;
  description: string;
  /** Established-science overview. No invented numbers. */
  overview: string;
  /** Why it is not simulated yet / what model it would need. */
  needs: string;
  relatedIds?: string[];
  tags: string[];
}
