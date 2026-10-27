import cardData from '../data/cards.json'

export type VocabularyCard = {
  word: string
  meaning: string
  example: string
}

export const cards: VocabularyCard[] = cardData
