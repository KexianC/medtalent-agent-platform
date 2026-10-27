import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeAnswers, describeAssessment, PERSONALITY_DESCRIPTIONS, PERSONALITY_DIMENSIONS,
  PERSONALITY_QUESTIONS, pickWellnessCard, scoreAssessment, scorePersonality, WELLNESS_CARDS, WELLNESS_SCALES,
} from '../src/features/yuwen/assessmentModel.ts';

test('GAD-7 includes seven scored items and excludes supplementary functional impact', () => {
  assert.equal(WELLNESS_SCALES.find(scale => scale.id === 'gad7').questions.length, 8);
  assert.deepEqual(scoreAssessment('gad7', [0, 0, 0, 0, 0, 0, 0, 3]), { score: 0, maxScore: 21 });
  assert.deepEqual(scoreAssessment('gad7', [3, 3, 3, 3, 3, 3, 3, 0]), { score: 21, maxScore: 21 });
  assert.deepEqual(scoreAssessment('gad7', [1, 2, 0, 3, 1, 2, 3, 2]), { score: 12, maxScore: 21 });
});

test('GAD-7 symptom bands use official 5, 10, 15 boundaries without diagnostic labels', () => {
  for (const score of [0, 4]) assert.equal(describeAssessment('gad7', score).label, '无或极轻度焦虑症状范围');
  for (const score of [5, 9]) assert.equal(describeAssessment('gad7', score).label, '轻度焦虑症状范围');
  for (const score of [10, 14]) assert.equal(describeAssessment('gad7', score).label, '中度焦虑症状范围');
  for (const score of [15, 21]) assert.equal(describeAssessment('gad7', score).label, '重度焦虑症状范围');
  for (const invalid of [-1, 22, NaN, Infinity, 1.5]) assert.equal(describeAssessment('gad7', invalid), null);
});

test('PHQ-2 scores 0 to 6 and uses a 3-point further-assessment reference', () => {
  assert.equal(WELLNESS_SCALES.find(scale => scale.id === 'phq2').questions.length, 2);
  assert.deepEqual(scoreAssessment('phq2', [0, 0]), { score: 0, maxScore: 6 });
  assert.deepEqual(scoreAssessment('phq2', [3, 3]), { score: 6, maxScore: 6 });
  assert.match(describeAssessment('phq2', 2).label, /^低于/);
  assert.match(describeAssessment('phq2', 3).label, /^达到/);
  assert.equal(describeAssessment('phq2', 7), null);
});

test('missing, fractional, coerced, sparse and extra answers are never silently scored', () => {
  for (const answers of [[], [0], [0, undefined], [0, null], ['0', 1], [false, 2], [0, 4], [0, -1], [0, 0.5], [0, NaN], [0, Infinity], [0, 0, 0], Array(2)]) {
    assert.equal(scoreAssessment('phq2', answers), null);
  }
  assert.equal(scoreAssessment('unknown', [0, 0]), null);
  assert.equal(scoreAssessment('gad7', Array(7).fill(0)), null);
  assert.equal(completeAnswers([0, 0], 2, 3), true);
  assert.equal(completeAnswers(null, 2, 3), false);
});

test('personality questions have five original prompts per dimension and valid option mapping', () => {
  assert.equal(PERSONALITY_QUESTIONS.length, 20);
  assert.equal(new Set(PERSONALITY_QUESTIONS.map(question => question.text)).size, 20);
  for (const dimension of PERSONALITY_DIMENSIONS) {
    const questions = PERSONALITY_QUESTIONS.filter(question => question.dimension === dimension.key);
    assert.equal(questions.length, 5);
    for (const question of questions) {
      assert.equal(question.options.length, 2);
      assert.ok([dimension.first, dimension.second].includes(question.firstOptionLetter));
    }
  }
});

test('all 16 personality combinations have complete descriptions and map both reversed and direct prompts', () => {
  assert.equal(Object.keys(PERSONALITY_DESCRIPTIONS).length, 16);
  for (let combination = 0; combination < 16; combination += 1) {
    const letters = PERSONALITY_DIMENSIONS.map((dimension, index) => (combination & (1 << index)) ? dimension.second : dimension.first);
    const answers = PERSONALITY_QUESTIONS.map(question => {
      const index = PERSONALITY_DIMENSIONS.findIndex(dimension => dimension.key === question.dimension);
      return question.firstOptionLetter === letters[index] ? 0 : 1;
    });
    const result = scorePersonality(answers);
    assert.equal(result.type, letters.join(''));
    assert.ok(PERSONALITY_DESCRIPTIONS[result.type].description.length > 10);
    assert.ok(PERSONALITY_DESCRIPTIONS[result.type].practice.length > 5);
    PERSONALITY_DIMENSIONS.forEach((dimension, index) => assert.equal(result.dimensions[dimension.key], letters[index] === dimension.first ? 100 : 0));
  }
});

test('personality majority is based on counted preferences and rejects incomplete input', () => {
  const answers = PERSONALITY_QUESTIONS.map(question => question.firstOptionLetter === question.dimension[0] ? 0 : 1);
  const firstDimensionIndices = PERSONALITY_QUESTIONS.map((question, index) => question.dimension === 'EI' ? index : -1).filter(index => index >= 0);
  firstDimensionIndices.slice(0, 2).forEach(index => { answers[index] = 1 - answers[index]; });
  assert.equal(scorePersonality(answers).type, 'ESTJ');
  assert.equal(scorePersonality(answers).dimensions.EI, 60);
  answers[firstDimensionIndices[2]] = 1 - answers[firstDimensionIndices[2]];
  assert.equal(scorePersonality(answers).type, 'ISTJ');
  assert.equal(scorePersonality(answers).dimensions.EI, 40);
  assert.equal(scorePersonality(Array(19).fill(0)), null);
  assert.equal(scorePersonality(Array(20).fill(null)), null);
  assert.equal(scorePersonality([...Array(19).fill(0), 2]), null);
});

test('eight random card bins are exhaustive, stable and do not accept out-of-range randomness', () => {
  assert.equal(WELLNESS_CARDS.length, 8);
  assert.equal(new Set(WELLNESS_CARDS.map(card => card.id)).size, 8);
  for (let index = 0; index < 8; index += 1) assert.equal(pickWellnessCard((index + 0.5) / 8).id, WELLNESS_CARDS[index].id);
  assert.equal(pickWellnessCard(0).id, WELLNESS_CARDS[0].id);
  assert.equal(pickWellnessCard(1 - Number.EPSILON).id, WELLNESS_CARDS[7].id);
  for (const invalid of [1, -0.1, Infinity, NaN]) assert.throws(() => pickWellnessCard(invalid), RangeError);
});
