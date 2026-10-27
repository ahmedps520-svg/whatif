/**
 * Physical constants shared by the orbital-mechanics models (SI units).
 *
 * Sources: CODATA 2018 (G, σ), IAU 2012 Resolution B2 (AU), IAU 2015
 * Resolution B3 nominal solar values (L☉, R☉, and M☉ = GM☉/G), NASA planetary
 * fact sheets (Earth, Moon and Jupiter masses and radii).
 */

/** Newtonian constant of gravitation, m³ kg⁻¹ s⁻² (CODATA 2018: 6.67430e-11). */
export const G = 6.674e-11;
/** Solar mass, kg. */
export const M_SUN = 1.98847e30;
/** Earth mass, kg. */
export const M_EARTH = 5.9722e24;
/** Moon mass, kg. */
export const M_MOON = 7.342e22;
/** Jupiter mass, kg. */
export const M_JUP = 1.89813e27;
/** Earth mean radius, m. */
export const R_EARTH = 6.371e6;
/** Moon mean radius, m. */
export const R_MOON = 1.7374e6;
/** Nominal solar radius, m. */
export const R_SUN = 6.957e8;
/** Astronomical unit, m (exact by definition). */
export const AU = 1.495978707e11;
/** Nominal solar luminosity, W. */
export const L_SUN = 3.828e26;
/** Earth–Moon mean centre-to-centre distance, m. */
export const EARTH_MOON_DISTANCE = 3.844e8;
/** Stefan–Boltzmann constant, W m⁻² K⁻⁴. */
export const SIGMA_SB = 5.670374419e-8;
/** One megatonne of TNT, J (by convention). */
export const MT_TNT = 4.184e15;

export const HOUR = 3600;
export const DAY = 86400;
export const YEAR = 365.25 * DAY;

/** Mean solar irradiance at 1 AU implied by L☉: L☉ / (4π AU²) ≈ 1361 W/m². */
export const S_EARTH = L_SUN / (4 * Math.PI * AU * AU);
/** Mean densities implied by the masses and radii above, kg/m³. */
export const RHO_EARTH = M_EARTH / ((4 / 3) * Math.PI * R_EARTH ** 3);
export const RHO_MOON = M_MOON / ((4 / 3) * Math.PI * R_MOON ** 3);
