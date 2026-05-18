/**
 * @file Similarity Calculator
 *
 * High-performance similarity metrics for vector comparison including cosine similarity,
 * euclidean distance, dot product, and Manhattan distance. Optimized for embedding
 * vectors with input validation and numerical stability.
 */

import { SearchError } from '../core/error-handling/';

/**
 * Calculates cosine similarity between two vectors
 * Returns value between -1 and 1, where 1 means identical direction
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  validateVectors(a, b);

  if (a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA * normB);

  // Handle zero vectors
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Calculates euclidean distance between two vectors
 * Returns value >= 0, where 0 means identical vectors
 */
export function euclideanDistance(a: number[], b: number[]): number {
  validateVectors(a, b);

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

/**
 * Calculates dot product between two vectors
 * Higher values indicate more similar vectors (for normalized vectors)
 */
export function dotProduct(a: number[], b: number[]): number {
  validateVectors(a, b);

  let product = 0;
  for (let i = 0; i < a.length; i++) {
    product += a[i] * b[i];
  }

  return product;
}

/**
 * Calculates Manhattan distance (L1 distance) between two vectors
 * Returns value >= 0, where 0 means identical vectors
 */
export function manhattanDistance(a: number[], b: number[]): number {
  validateVectors(a, b);

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }

  return sum;
}

/**
 * Calculates multiple similarity metrics at once for efficiency
 */
export function calculateAllMetrics(
  a: number[],
  b: number[]
): {
  cosine: number;
  euclidean: number;
  dotProduct: number;
  manhattan: number;
} {
  validateVectors(a, b);

  let dotProd = 0;
  let normA = 0;
  let normB = 0;
  let euclideanSum = 0;
  let manhattanSum = 0;

  for (let i = 0; i < a.length; i++) {
    const valA = a[i];
    const valB = b[i];
    const diff = valA - valB;

    dotProd += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
    euclideanSum += diff * diff;
    manhattanSum += Math.abs(diff);
  }

  const magnitude = Math.sqrt(normA * normB);
  const cosine = magnitude === 0 ? 0 : dotProd / magnitude;

  return {
    cosine,
    euclidean: Math.sqrt(euclideanSum),
    dotProduct: dotProd,
    manhattan: manhattanSum,
  };
}

/**
 * Batch similarity calculation for multiple vectors against a query vector
 * More efficient than individual calculations
 */
export function batchCosineSimilarity(
  query: number[],
  vectors: number[][]
): number[] {
  if (!Array.isArray(query) || query.length === 0) {
    throw new SearchError('Invalid query vector', 'INVALID_VECTOR');
  }

  if (!Array.isArray(vectors) || vectors.length === 0) {
    throw new SearchError('Invalid vectors array', 'INVALID_VECTORS');
  }

  // Use typed arrays for better performance with large vectors
  const useTypedArrays = query.length > 100 || vectors.length > 50;

  if (useTypedArrays) {
    return batchCosineSimilarityTyped(query, vectors);
  }

  return batchCosineSimilarityStandard(query, vectors);
}

/**
 * Core cosine-similarity inner loop. Works over any ArrayLike<number>,
 * so the typed (Float32Array) and standard (number[]) variants share
 * the algorithm without giving up the typed-array perf path — the
 * caller converts inputs once, then uses the shared kernel.
 */
function cosineSimilarityKernel(
  queryVec: ArrayLike<number>,
  vectors: number[][],
  toVec: (v: number[]) => ArrayLike<number>,
  expectedLength: number
): number[] {
  let queryNorm = 0;
  for (let i = 0; i < queryVec.length; i++) {
    queryNorm += queryVec[i] * queryVec[i];
  }
  queryNorm = Math.sqrt(queryNorm);

  if (queryNorm === 0) {
    return new Array(vectors.length).fill(0);
  }

  return vectors.map(vector => {
    if (!Array.isArray(vector) || vector.length !== expectedLength) {
      throw new SearchError('Vector dimension mismatch', 'DIMENSION_MISMATCH');
    }

    const vec = toVec(vector);
    let dotProduct = 0;
    let vectorNorm = 0;

    for (let i = 0; i < queryVec.length; i++) {
      dotProduct += queryVec[i] * vec[i];
      vectorNorm += vec[i] * vec[i];
    }

    vectorNorm = Math.sqrt(vectorNorm);
    if (vectorNorm === 0) return 0;
    return dotProduct / (queryNorm * vectorNorm);
  });
}

function batchCosineSimilarityStandard(
  query: number[],
  vectors: number[][]
): number[] {
  return cosineSimilarityKernel(query, vectors, v => v, query.length);
}

function batchCosineSimilarityTyped(
  query: number[],
  vectors: number[][]
): number[] {
  const queryTyped = new Float32Array(query);
  return cosineSimilarityKernel(
    queryTyped,
    vectors,
    v => new Float32Array(v),
    query.length
  );
}

/**
 * Finds the top K most similar vectors using cosine similarity
 */
export function findTopKSimilar(
  query: number[],
  vectors: number[][],
  k: number,
  metadata?: any[]
): Array<{ index: number; similarity: number; metadata?: any }> {
  const similarities = batchCosineSimilarity(query, vectors);

  // Create array of indices with similarities
  const indexed = similarities.map((similarity, index) => ({
    index,
    similarity,
    metadata: metadata?.[index],
  }));

  // Sort by similarity (descending) and take top K
  return indexed.sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

/**
 * Normalizes a vector to unit length
 */
export function normalizeVector(vector: number[]): number[] {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new SearchError('Invalid vector for normalization', 'INVALID_VECTOR');
  }

  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i] * vector[i];
  }

  norm = Math.sqrt(norm);

  if (norm === 0) {
    return new Array(vector.length).fill(0);
  }

  return vector.map(val => val / norm);
}

/**
 * Validates that two vectors are compatible for similarity calculation
 */
function validateVectors(a: number[], b: number[]): void {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new SearchError('Vectors must be arrays', 'INVALID_VECTOR_TYPE');
  }

  if (a.length !== b.length) {
    throw new SearchError(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`,
      'DIMENSION_MISMATCH'
    );
  }

  if (a.length === 0) {
    throw new SearchError('Vectors cannot be empty', 'EMPTY_VECTOR');
  }

  // Check for invalid numbers
  for (let i = 0; i < a.length; i++) {
    if (!isFinite(a[i]) || !isFinite(b[i])) {
      throw new SearchError(
        'Vectors contain invalid numbers',
        'INVALID_NUMBERS'
      );
    }
  }
}
