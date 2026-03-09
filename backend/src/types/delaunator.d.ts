declare module "delaunator" {
    export default class Delaunator {
        constructor(coords: number[] | Float64Array);
        triangles: Uint32Array;
        halfedges: Int32Array;
        hull: Uint32Array;
        coords: number[] | Float64Array;
    }
}
