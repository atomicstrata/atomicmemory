/**
 * Tests for assistant-turn fact extraction in quick-extraction.
 *
 * Validates that fact-bearing assistant turns are indexed while
 * generic chatter is filtered out. Based on LongMemEval_s patterns
 * where answers exist only in assistant turns.
 */

import { describe, expect, it } from 'vitest';
import { quickExtractFacts } from '../quick-extraction.js';

describe('quickExtractFacts — assistant turns', () => {
  it('extracts named restaurant from assistant recommendation', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-05-20]',
      'User: Can you recommend any good restaurants near Cihampelas Walk?',
      'Assistant: Sure! Here are a few options:\n\n1. Miss Bee Providore: This restaurant serves a mix of western and Indonesian cuisine and has a cozy atmosphere.\n\n2. Warung Nasi Ampera: A popular spot for authentic Sundanese food.',
    ].join('\n'));

    expect(facts.some((f) => f.fact.includes('Miss Bee Providore'))).toBe(true);
  });

  it('extracts shift schedule details from assistant-generated table', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-04-15]',
      'User: Create a shift rotation for 7 agents.',
      'Assistant: Here is the shift rotation sheet:\n| Agent | Sunday | Monday |\n| Admon | 8 am - 4 pm | 12 pm - 8 pm |\n| Sara | 4 pm - 12 am | 8 am - 4 pm |',
    ].join('\n'));

    expect(facts.some((f) => f.fact.includes('Admon'))).toBe(true);
  });

  it('extracts factual content from assistant creative writing', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-03-10]',
      'User: Write a children\'s book about dinosaurs.',
      'Assistant: "The Amazing Adventures of Dinosaurs"\n\nOnce upon a time, in a land far away, there lived incredible creatures called dinosaurs. The Plesiosaur had a beautiful blue scaly body and long graceful neck.',
    ].join('\n'));

    expect(facts.some((f) => f.fact.includes('Plesiosaur'))).toBe(true);
  });

  it('filters out generic assistant acknowledgments', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-05-01]',
      'User: I work at Google.',
      'Assistant: Got it! I\'ll remember that.',
      'User: I prefer TypeScript.',
      'Assistant: Sure, noted!',
    ].join('\n'));

    const assistantFacts = facts.filter((f) => f.fact.includes('Got it') || f.fact.includes('noted'));
    expect(assistantFacts).toHaveLength(0);
    expect(facts.some((f) => f.fact.includes('Google'))).toBe(true);
  });

  it('filters out "as an AI" meta-commentary', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-05-20]',
      'User: What do you think about Bandung?',
      "Assistant: As an AI language model, I don't have personal experiences, but based on research, Bandung is known for its factory outlets and tea plantations.",
    ].join('\n'));

    const aiFacts = facts.filter((f) => f.fact.includes('As an AI'));
    expect(aiFacts).toHaveLength(0);
  });

  it('still extracts user-turn facts alongside assistant facts', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-06-01]',
      'User: I work at a startup in Bandung.',
      'Assistant: Congratulations! Miss Bee Providore in Bandung also has a great business lunch menu with options for everyone.',
    ].join('\n'));

    expect(facts.some((f) => f.fact.toLowerCase().includes('work at a startup'))).toBe(true);
    expect(facts.some((f) => f.fact.includes('Miss Bee Providore'))).toBe(true);
  });

  it('does not rewrite assistant pronouns to "user"', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-07-01]',
      'Assistant: Miss Bee Providore offers a variety of delicious dishes, both Western and Indonesian cuisine. Their Nasi Goreng is a signature dish.',
    ].join('\n'));

    const missBee = facts.find((f) => f.fact.includes('Miss Bee Providore'));
    expect(missBee).toBeDefined();
    expect(missBee!.fact).not.toContain("user's");
    expect(missBee!.fact).not.toContain('user offers');
  });

  it('anchors assistant facts with session date', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-04-15]',
      'Assistant: The Plesiosaur had a beautiful blue scaly body and swam gracefully through ancient seas.',
    ].join('\n'));

    const plesiosaur = facts.find((f) => f.fact.includes('Plesiosaur'));
    expect(plesiosaur).toBeDefined();
    expect(plesiosaur!.fact).toContain('April 15 2023');
  });

  it('extracts proper noun sequences from assistant turns', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-05-20]',
      'User: Any tea house recommendations?',
      'Assistant: Kampung Daun is a popular and picturesque tea house that features traditional Sundanese architecture.',
    ].join('\n'));

    expect(facts.some((f) => f.fact.includes('Kampung Daun'))).toBe(true);
  });

  it('handles multi-line assistant responses with mixed content', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-05-20]',
      'User: What fun activities are there in Bandung?',
      'Assistant: Sure, Bandung has plenty of fun activities to offer! Here are a few recommendations:\n\n1. Visit a volcano: Bandung is located near Tangkuban Perahu and Kawah Putih.\n\n2. Explore tea plantations: Try the famous Malabar Tea Estate.',
    ].join('\n'));

    expect(facts.some((f) => f.fact.includes('Tangkuban Perahu'))).toBe(true);
  });
});
