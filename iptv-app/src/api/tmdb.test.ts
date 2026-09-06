import { describe, expect, it } from 'vitest'
import { mapDetails, img, type RawDetails } from './tmdb'
import movie from './__fixtures__/tmdb_movie_19995.json'
import tv from './__fixtures__/tmdb_tv_1396.json'

describe('TMDB mapping', () => {
  it('maps a movie with logo, cast, director and similar titles', () => {
    const e = mapDetails('movie', movie as unknown as RawDetails)
    expect(e.title).toBe('Avatar')
    expect(e.year).toBe(2009)
    expect(e.director).toBe('James Cameron')
    expect(e.cast.length).toBeGreaterThan(5)
    expect(e.cast[0]).toMatchObject({ name: expect.any(String), profile: expect.stringContaining('image.tmdb.org') })
    expect(e.logo).toMatch(/^https:\/\/image\.tmdb\.org\/t\/p\/w500\/.+\.(png|svg)$/)
    expect(e.backdrop).toMatch(/w1280/)
    expect(e.poster).toMatch(/w500/)
    expect(e.genres.length).toBeGreaterThan(0)
    expect(e.similar.length).toBeGreaterThan(0)
    expect(e.overview).toBeTruthy()
  })
  it('maps a tv show with creators and seasons', () => {
    const e = mapDetails('tv', tv as unknown as RawDetails)
    expect(e.title).toBe('Breaking Bad')
    expect(e.creators).toContain('Vince Gilligan')
    expect(e.seasons).toBe(5)
    expect(e.runtime).toBeGreaterThan(0)
    expect(e.logo).toBeTruthy()
  })
  it('builds image urls', () => {
    expect(img('/abc.jpg', 'w342')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg')
    expect(img(null)).toBeUndefined()
  })
})
