import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

const briefs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/briefs' }),
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
