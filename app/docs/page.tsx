'use client'

import { useState, useEffect } from 'react'
import NavBar from '@/components/NavBar'
import { getDocs } from '@/lib/storage'
import { Doc } from '@/lib/types'

const TAG_COLORS = [
  'from-blue-500 to-purple-500',
  'from-green-500 to-teal-500',
  'from-yellow-500 to-orange-500',
  'from-pink-500 to-red-500',
  'from-indigo-500 to-blue-500',
  'from-cyan-500 to-blue-500',
]

export default function DocsPage() {
  const [docs, setDocsState] = useState<Doc[]>([])
  const [selectedTag, setSelectedTag] = useState('All')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      const loaded = await getDocs()
      setDocsState(loaded)
      setLoading(false)
    })()
  }, [])

  const allTags = Array.from(new Set(docs.map((d) => d.tag)))
  const tags = ['All', ...allTags]
  const filtered = selectedTag === 'All' ? docs : docs.filter((d) => d.tag === selectedTag)

  const getGradientColor = (index: number) => {
    return TAG_COLORS[index % TAG_COLORS.length]
  }

  if (loading) return <div>Loading...</div>

  return (
    <div className="min-h-screen bg-los-bg">
      <NavBar />

      <div className="mt-60px p-6" style={{ marginTop: '60px' }}>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-los-text">Docs</h1>
          <button className="px-4 py-2 bg-los-accent text-white rounded-lg hover:bg-blue-600">
            + Add Doc
          </button>
        </div>

        {/* Tag Filter */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {tags.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTag(tag)}
              className={`px-4 py-2 rounded-full font-medium whitespace-nowrap transition ${
                selectedTag === tag
                  ? 'bg-los-accent text-white'
                  : 'bg-los-surface text-los-text-muted hover:bg-los-surface-2'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>

        {/* Docs Grid */}
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-los-text-muted">No documents yet</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map((doc, idx) => (
              <a
                key={doc.id}
                href={doc.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group los-card overflow-hidden hover:shadow-los-card-hover transition"
              >
                {/* Gradient Thumbnail */}
                <div
                  className={`h-24 bg-gradient-to-br ${getGradientColor(idx)} opacity-80 group-hover:opacity-100 transition`}
                />

                {/* Content */}
                <div className="p-4">
                  <h3 className="font-semibold text-los-text mb-2 group-hover:text-los-accent transition">
                    {doc.name}
                  </h3>
                  <span className="inline-block text-xs bg-los-surface-2 text-los-text-muted px-2 py-1 rounded">
                    {doc.tag}
                  </span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
