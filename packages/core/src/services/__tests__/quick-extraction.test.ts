/**
 * Unit tests for deterministic quick extraction coverage on temporal facts.
 */

import { describe, expect, it } from 'vitest';
import { quickExtractFacts } from '../quick-extraction.js';

describe('quickExtractFacts', () => {
  it('anchors session dates and extracts Plaid from terse project updates', () => {
    const facts = quickExtractFacts(
      '[Session date: 2026-01-22]\nUser: Quick update on the finance tracker. I added Plaid integration for bank account syncing.',
    );

    expect(facts.some((fact) => fact.fact.includes('January 22 2026'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('Plaid integration'))).toBe(true);
  });

  it('keeps whole-turn temporal detail for Tailwind duration facts', () => {
    const facts = quickExtractFacts(
      "[Session date: 2026-01-15]\nUser: Tailwind CSS. I've been using it for the last year and can't go back to regular CSS.",
    );

    expect(facts.some((fact) => fact.fact.includes('last year'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('Tailwind CSS'))).toBe(true);
  });

  it('annotates relative temporal phrases with explicit anchors', () => {
    const facts = quickExtractFacts(
      '[Session date: 2023-01-20]\nUser: Lost my job as a banker yesterday. Unfortunately I also lost my job at Door Dash this month. I plan to perform at a nearby festival next month. Started hitting the gym last week. I attended a workshop last month.',
    );

    expect(facts.some((fact) => fact.fact.includes('yesterday (on January 19, 2023)'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('this month (in January 2023)'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('next month (in February 2023)'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('last week (around January 13, 2023)'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('last month (in December 2022)'))).toBe(true);
  });

  it('preserves advisor and backup-plan detail in a multi-sentence turn', () => {
    const facts = quickExtractFacts(
      '[Session date: 2026-02-15]\nUser: I got some career advice from Dr. Chen. She said I should also consider industry research labs as a backup plan.',
    );

    expect(facts.some((fact) => fact.fact.includes('Dr. Chen'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('industry research labs'))).toBe(true);
  });

  it('extracts standalone academic timeline facts without first-person verbs', () => {
    const facts = quickExtractFacts(
      '[Session date: 2026-01-10]\nUser: One first-author paper at EMNLP 2025 on cross-lingual transfer learning for low-resource languages.',
    );

    expect(facts.some((fact) => fact.fact.includes('EMNLP 2025'))).toBe(true);
  });

  it('captures literal object and store-detail facts', () => {
    const facts = quickExtractFacts(
      '[Session date: 2023-02-01]\nUser: My necklace from grandma symbolizes love, faith, and strength. I found the perfect spot for my clothing store and designed the space, furniture, and decor.',
    );

    expect(facts.some((fact) => fact.fact.includes('necklace from grandma symbolizes love, faith, and strength'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('perfect spot for my clothing store'))).toBe(true);
  });

  it('captures quoted poster text and named pet details', () => {
    const facts = quickExtractFacts(
      '[Session date: 2023-09-13]\nUser: The posters at the poetry reading said "Trans Lives Matter". I have two cats and a dog. Oliver hid his bone in my slipper once.',
    );

    expect(facts.some((fact) => fact.fact.includes('"Trans Lives Matter"'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('Oliver hid his bone in my slipper once'))).toBe(true);
  });

  it('keeps multi-word titles as single entities', () => {
    const facts = quickExtractFacts(
      "[Session date: 2023-10-13]\nUser: Caroline recommended Becoming Nicole to me. My favorite childhood book was Charlotte's Web.",
    );

    expect(facts.some((fact) => fact.entities.some((entity) => entity.name === 'Becoming Nicole'))).toBe(true);
    expect(facts.some((fact) => fact.entities.some((entity) => entity.name === "Charlotte's Web"))).toBe(true);
  });

  it('captures late-timeline event facts from speaker-labeled LoCoMo sessions', () => {
    const facts = quickExtractFacts(
      [
        '[Session date: 2023-07-21]',
        'Jon: Awesome advice! Lately I\'ve been networking and it\'s gotten me some good stuff.',
        'Jon: Started to learn all these marketing and analytics tools to push the biz forward today.',
        'Gina: Let\'s create some cool content and manage your social media accounts.',
        'Jon: Sounds great. I\'d really appreciate your help with making content and managing my social media. Let\'s get together and make the dance studio look awesome!',
        'Gina: Hah, yeah!) But really having a creative space for dancers is so important. Last Friday at dance class with a group of friends I felt it.',
        'Gina: It\'s Shia Labeouf!',
      ].join('\n'),
    );

    expect(facts.some((fact) => fact.fact.includes('networking'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('today (on July 21, 2023)'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('social media accounts'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('Last Friday (on July 14, 2023)'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('Shia Labeouf'))).toBe(true);
  });

  it('captures terse LoCoMo duration and medical event turns', () => {
    const facts = quickExtractFacts(
      [
        '[Session date: 2023-05-24]',
        'Nate: I like having some of these little turtles around to keep me calm.',
        "Nate: I've had them for 3 years now and they bring me tons of joy!",
        "Sam: Thanks, Evan. Appreciate the offer, but had a check-up with my doctor a few days ago and, yikes, the weight wasn't great.",
      ].join('\n'),
    );

    expect(facts.some((fact) => fact.fact.includes('Nate has had the turtles for 3 years now'))).toBe(true);
    expect(facts.some((fact) => fact.fact.includes('Sam had a check-up with Sam\'s doctor a few days ago'))).toBe(true);
  });
});
