import { defineCollection, z } from 'astro:content'

const briefs = defineCollection({
  type: 'content',
  schema: z.object({
    date: z.string(),
    hotLeads: z.number().default(0),
    watchList: z.number().default(0),
    totalItems: z.number().default(0),
    sourcesChecked: z.number().default(0),
    sourcesFailed: z.number().default(0),
  }),
})

export const collections = { briefs }
